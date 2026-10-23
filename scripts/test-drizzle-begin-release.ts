/**
 * A failed BEGIN inside db.transaction must release (destroy) the checked-out client; stock drizzle leaks it, which
 * showed up in production as a db:long_checkout error every 5s. Uses a fake client; no database round trip.
 */
import assert from "node:assert/strict";

const { pool, db } = await import("../server/db");

let released: unknown[] = [];
const realConnect = pool.connect.bind(pool);
const fakeClient: any = {
  query: async (text: any) => {
    const sqlText = typeof text === "string" ? text : text?.text ?? "";
    if (/^\s*begin/i.test(sqlText)) throw new Error("Connection terminated unexpectedly");
    return { rows: [], rowCount: 0, fields: [] };
  },
  release: (arg?: unknown) => { released.push(arg ?? "reuse"); },
};
(pool as any).connect = async () => fakeClient;
try {
  await assert.rejects(() => db.transaction(async () => "never"), /Failed query: begin/);
  assert.deepEqual(released, [true], "client whose BEGIN failed is released exactly once and destroyed");

  released = [];
  fakeClient.query = async () => ({ rows: [], rowCount: 0, fields: [] });
  assert.equal(await db.transaction(async () => "ok"), "ok");
  assert.deepEqual(released, ["reuse"], "a healthy transaction releases its client back to the pool");

  released = [];
  await assert.rejects(() => db.transaction(async () => { throw new Error("boom"); }), /boom/);
  assert.deepEqual(released, ["reuse"], "a rolled-back transaction releases its client");
} finally {
  (pool as any).connect = realConnect;
}
console.log("PASS drizzle BEGIN failure releases the checked-out client (3 checks)");
await pool.end().catch(() => {});
process.exit(0);
