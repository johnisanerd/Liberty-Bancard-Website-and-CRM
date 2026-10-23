import assert from "node:assert/strict";

// A failed BEGIN inside db.transaction must release (and destroy) the checked-out client; drizzle 0.45 leaked it.
// Uses a stub client on the real pool.connect path; no database statement is executed.
const { db, pool } = await import("../server/db");
let checks = 0;
const check = (ok: unknown, label: string) => { assert.ok(ok, label); checks++; console.log(`✓ ${label}`); };

const originalConnect = pool.connect;
function stubClient(failOn: RegExp | null, log: { queries: string[]; released: unknown[] }) {
  return {
    query: async (config: any) => {
      const text = typeof config === "string" ? config : config?.text ?? "";
      log.queries.push(text);
      if (failOn && failOn.test(text)) throw new Error("connection terminated");
      return { rows: [], rowCount: 0, fields: [] };
    },
    release: (arg?: unknown) => { log.released.push(arg ?? false); },
  };
}
async function run(failOn: RegExp | null, body: () => Promise<unknown>) {
  const log = { queries: [] as string[], released: [] as unknown[] };
  (pool as any).connect = async () => stubClient(failOn, log);
  let error: unknown = null, result: unknown;
  try { result = await db.transaction(async () => body()); } catch (e) { error = e; }
  return { log, error, result };
}
try {
  const begin = await run(/^begin/i, async () => "unused");
  check(begin.error && begin.log.released.length === 1 && begin.log.released[0] === true,
    "a failed BEGIN rejects, releases the client exactly once and destroys it");
  check(!begin.log.queries.some(q => /^(commit|rollback)/i.test(q)), "no commit or rollback is sent after a failed BEGIN");

  const ok = await run(null, async () => "done");
  check(ok.result === "done" && ok.log.released.length === 1 && ok.log.released[0] === false
    && ok.log.queries.map(q => q.trim().split(/\s/)[0].toLowerCase()).join(",") === "begin,commit", "a successful transaction begins, commits and releases normally");

  const failed = await run(null, async () => { throw new Error("boom"); });
  check((failed.error as Error)?.message === "boom" && failed.log.released.length === 1 && failed.log.released[0] === false
    && failed.log.queries.map(q => q.trim().split(/\s/)[0].toLowerCase()).join(",") === "begin,rollback", "a failing body rolls back, rethrows the original error and releases");
  console.log(`DB transaction BEGIN release: PASS (${checks} checks)`);
} finally {
  (pool as any).connect = originalConnect;
  await pool.end().catch(() => undefined);
}
