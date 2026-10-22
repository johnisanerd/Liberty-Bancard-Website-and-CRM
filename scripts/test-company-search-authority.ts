import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { assertDisposableTestInfrastructure } from "./test-infrastructure-guard";

await assertDisposableTestInfrastructure({ operation: "Company search authority", requireRedis: false });
const { searchCompanies, decodeCompanyCursor } = await import("../server/services/company-authority");
const { pool } = await import("../server/db");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const nonce = randomUUID().slice(0, 8);
const adminId = `cs-admin-${nonce}`, agentId = `cs-agent-${nonce}`, otherId = `cs-other-${nonce}`;
let checks = 0;
const check = (value: unknown, label: string) => { assert.ok(value, label); checks++; console.log(`✓ ${label}`); };
const TOTAL = 1150, AGENT_OWN = 40;
try {
  await client.query(`INSERT INTO users (id,email,role) VALUES ($1,$2,'admin'),($3,$4,'agent'),($5,$6,'agent')`,
    [adminId, `${adminId}@example.test`, agentId, `${agentId}@example.test`, otherId, `${otherId}@example.test`]);
  const actors = Object.fromEntries((await client.query(`SELECT id,auth_epoch,account_version FROM users WHERE id=ANY($1)`, [[adminId, agentId, otherId]])).rows
    .map(r => [r.id, { id: r.id, authEpoch: r.auth_epoch, accountVersion: r.account_version }]));
  // Bulk fixture above 1,000 rows: all admin-visible; only AGENT_OWN created by the agent; the rest by another agent.
  await client.query(`INSERT INTO companies (legal_name,created_by_user_id)
    SELECT 'Search ${nonce} ' || lpad(g::text,5,'0') || CASE WHEN g%7=0 THEN ' Co_%' ELSE '' END, CASE WHEN g<=$2 THEN $3 ELSE $4 END
    FROM generate_series(1,$1) g`, [TOTAL, AGENT_OWN, agentId, otherId]);
  const q = `Search ${nonce}`;

  const first = await searchCompanies(actors[adminId], { q });
  check(first.items.length === 25 && first.limit === 25, "Default page is 25");
  check(first.total === TOTAL, `Exact total reports ${TOTAL} authorized matches, not a 1,000-row cap`);
  const big = await searchCompanies(actors[adminId], { q, limit: 50 });
  check(big.items.length === 50 && big.limit === 50, "Optional limit 50 is honored");
  check((await searchCompanies(actors[adminId], { q, limit: 500 })).items.length === 50, "Limit above 50 is bounded to 50");

  // Walk every page: stable order, no duplicates, no gaps.
  const seen: number[] = []; let cursor: string | undefined; let pages = 0; let lastName = "";
  do {
    const page = await searchCompanies(actors[adminId], { q, limit: 50, cursor });
    for (const item of page.items) {
      const key = item.legalName.toLowerCase();
      assert.ok(key >= lastName, "ordered"); lastName = key; seen.push(item.id);
    }
    cursor = page.nextCursor ?? undefined; pages++;
  } while (cursor);
  check(seen.length === TOTAL && new Set(seen).size === TOTAL && pages === Math.ceil(TOTAL / 50), "Cursor pagination covers every company once in stable order");

  // Agent: predicate applies before the limit and the total.
  const agentFirst = await searchCompanies(actors[agentId], { q, limit: 50 });
  check(agentFirst.total === AGENT_OWN && agentFirst.items.length === AGENT_OWN && agentFirst.nextCursor === null,
    "Agent total and page contain only the agent's authorized companies");
  check((await searchCompanies(actors[otherId], { q })).total === TOTAL - AGENT_OWN, "Another agent sees a disjoint authorized set");
  const adminOnly = (await searchCompanies(actors[agentId], { q: `${q} 01100` }));
  check(adminOnly.total === 0 && adminOnly.items.length === 0, "A company outside the agent's authority is not searchable by name");

  // Query semantics: LIKE metacharacters are literal.
  const literal = await searchCompanies(actors[adminId], { q: "Co_%" });
  check(literal.total === Math.floor(TOTAL / 7), "Percent and underscore are matched literally");
  check((await searchCompanies(actors[adminId], { q: "%" })).total === Math.floor(TOTAL / 7), "A bare percent does not match everything");
  check((await searchCompanies(actors[adminId], { q: `zzz-no-match-${nonce}` })).total === 0, "No-match returns an empty authorized page");

  // Cursor from one actor cannot widen another actor's results: predicate is re-applied per read.
  const adminCursor = (await searchCompanies(actors[adminId], { q, limit: 5 })).nextCursor!;
  const agentWithAdminCursor = await searchCompanies(actors[agentId], { q, limit: 50, cursor: adminCursor });
  check(agentWithAdminCursor.total === AGENT_OWN,
    "A cursor never changes the actor's total");
  const ids = new Set((await client.query(`SELECT id FROM companies WHERE created_by_user_id=$1 AND legal_name LIKE $2`, [agentId, `${q}%`])).rows.map(r => r.id));
  check(agentWithAdminCursor.items.every(i => ids.has(i.id)), "A cursor from another actor still returns only this actor's companies");

  // Invalid cursors fail loudly with 400.
  for (const bad of ["not-base64!!", Buffer.from("{}").toString("base64url"), Buffer.from(JSON.stringify({ n: 1, i: 1 })).toString("base64url")]) {
    let status = 0; try { decodeCompanyCursor(bad); } catch (e: any) { status = e.status; }
    check(status === 400, "Malformed cursor is rejected with 400");
  }

  // Stale actor: a changed auth epoch is refused.
  await client.query(`UPDATE users SET auth_epoch=auth_epoch+1 WHERE id=$1`, [agentId]);
  let stale = 0; try { await searchCompanies(actors[agentId], { q }); } catch (e: any) { stale = e.status; }
  check(stale === 404, "A stale actor epoch is refused");

  // excludeContactId pins contact authority and hides already-linked companies.
  const contactId = (await client.query(`INSERT INTO contacts (first_name,last_name,email,phone,record_class,assigned_to)
    VALUES ('Cs','Fixture',$1,$3,'production',$2) RETURNING id`, [`cs-${nonce}@example.test`, `${otherId}@example.test`, `+1305${String(Math.floor(Math.random()*9e6)+1e6)}`])).rows[0].id;
  const linkTarget = (await client.query(`SELECT id FROM companies WHERE legal_name LIKE $1 ORDER BY id DESC LIMIT 1`, [`${q}%`])).rows[0].id;
  await client.query(`INSERT INTO contact_companies (contact_id,company_id,role,is_primary) VALUES ($1,$2,'Owner',true)`, [contactId, linkTarget]);
  const excl = await searchCompanies(actors[adminId], { q, limit: 50, excludeContactId: contactId });
  check(excl.total === TOTAL - 1, "Already-linked companies are excluded from the picker");
  let denied = 0; try { await searchCompanies(actors[otherId], { q, excludeContactId: 999999999 }); } catch (e: any) { denied = e.status; }
  check(denied === 404, "A contact outside the actor's authority cannot be used to scope a search");
  console.log(`PASS company search authority: ${checks} checks`);
} finally {
  await client.query(`DELETE FROM contact_companies WHERE company_id IN (SELECT id FROM companies WHERE legal_name LIKE $1)`, [`Search ${nonce}%`]).catch(() => {});
  await client.query(`DELETE FROM contacts WHERE email=$1`, [`cs-${nonce}@example.test`]).catch(() => {});
  await client.query(`DELETE FROM companies WHERE legal_name LIKE $1`, [`Search ${nonce}%`]).catch(() => {});
  await client.query(`DELETE FROM users WHERE id=ANY($1)`, [[adminId, agentId, otherId]]).catch(() => {});
  await client.end(); await pool.end();
}
