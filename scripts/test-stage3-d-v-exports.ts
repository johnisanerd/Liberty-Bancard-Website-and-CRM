import assert from "node:assert/strict";
import express from "express";
import { parse } from "csv-parse/sync";
import { stage3BHttpFixture } from "./fixtures/stage3-b-http";
import { streamKeysetCsv } from "../server/services/bounded-csv-export";

// E1: /api/export/{contacts,deals,tickets} are complete (no 500-row cap), deterministic, authorized by the shared read
// predicates, escape CSV correctly, resolve deal contacts by linked id, and fail visibly rather than ending a short file.
let checks = 0;
const check = (ok: unknown, label: string) => { assert.ok(ok, label); checks++; console.log(`✓ ${label}`); };
const h = await stage3BHttpFixture(async app => {
  const { registerCrmOperationsRoutes } = await import("../server/routes/crm-operations.ts");
  registerCrmOperationsRoutes(app);
  app.use("/api", (_req, res) => res.status(501).json({ message: "Unregistered isolated service" }));
});
async function csv(role: string, path: string) {
  const session = h.sessions.get(role)!;
  const res = await h.originalFetch(h.base + path, { headers: { Cookie: session.cookie } });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
try {
  const N = 1250;
  const ids: number[] = [];
  for (let i = 0; i < N; i++) {
    const name = i === 3 ? 'Quo"te, Name\nLine' : `Export${i}`;
    ids.push((await h.pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,record_class,status,company_name)
      VALUES($1,'Fixture',$2,'','production','New',$3) RETURNING id`, [name, `${h.prefix}-exp-${i}@example.test`, `Co ${i}`])).rows[0].id);
  }
  const expectedContacts = Number((await h.pool.query("SELECT COUNT(*) FROM contacts WHERE archived_at IS NULL")).rows[0].count);
  assert.ok(expectedContacts > 1000, "fixture exceeds one page");

  const contacts = await csv("admin", "/api/export/contacts");
  check(contacts.status === 200 && /text\/csv/.test(contacts.headers.get("content-type") ?? ""), "contacts export returns CSV");
  const contactRows: string[][] = parse(contacts.text);
  check(contactRows.length - 1 === expectedContacts && expectedContacts > 500, `contacts export is complete (${expectedContacts} rows, not capped at 500)`);
  const contactIds = contactRows.slice(1).map(r => Number(r[0]));
  check(contactIds.every((id, i) => i === 0 || id > contactIds[i - 1]) && new Set(contactIds).size === contactIds.length, "contacts are ascending by id with no duplicates across pages");
  check(contactRows.some(r => r[1] === 'Quo"te, Name\nLine'), "quotes, commas and newlines survive CSV round trip");
  const archivedId = ids[10];
  await h.pool.query("UPDATE contacts SET archived_at=NOW() WHERE id=$1", [archivedId]);
  const afterArchive: string[][] = parse((await csv("admin", "/api/export/contacts")).text);
  check(afterArchive.length - 1 === expectedContacts - 1 && !afterArchive.some(r => Number(r[0]) === archivedId), "archived contacts are excluded, same as People");
  const filtered: string[][] = parse((await csv("admin", "/api/export/contacts?search=Export7")).text);
  check(filtered.length > 1 && filtered.length - 1 < expectedContacts && filtered.slice(1).every(r => /Export7|Co 7/.test(r[1] + r[5])), "search filter narrows the export like People");
  for (const role of ["agent", "merchant"]) check((await csv(role, "/api/export/contacts")).status === 403, `${role} cannot export contacts`);

  // Deals: more than one page, linked contacts spread across every page of contacts.
  const dealIds: number[] = [];
  for (let i = 0; i < 1100; i++) {
    const contactId = ids[(i * 7919) % N];
    if (contactId === archivedId) { continue; }
    dealIds.push((await h.pool.query(`INSERT INTO deals(contact_id,pipeline,stage,record_class,offer_path) VALUES($1,'sales','New Lead','production','Interchange Plus') RETURNING id`, [contactId])).rows[0].id);
  }
  const expectedDeals = Number((await h.pool.query("SELECT COUNT(*) FROM deals WHERE archived_at IS NULL AND record_class='production'")).rows[0].count);
  const dealRows: string[][] = parse((await csv("manager", "/api/export/deals")).text);
  check(dealRows.length - 1 === expectedDeals && expectedDeals > 1000, `deals export is complete (${expectedDeals} rows)`);
  const mine = dealRows.slice(1).filter(r => dealIds.includes(Number(r[0])));
  check(mine.length === dealIds.length && mine.every(r => r[1].length > 0 && r[2].startsWith("Co ")), "every deal resolves its contact by linked id, including contacts outside the first 500 or 1000");
  const dIds = dealRows.slice(1).map(r => Number(r[0]));
  check(dIds.every((id, i) => i === 0 || id > dIds[i - 1]), "deals are ascending by id");
  check((await csv("agent", "/api/export/deals")).status === 403, "agent cannot export deals");

  for (let i = 0; i < 1010; i++) await h.pool.query(`INSERT INTO tickets(subject,description,category,priority,status,contact_id) VALUES($1,'fixture','Other','Normal','Open',$2)`, [`Export ticket ${i}, "q"`, ids[i % N]]);
  const expectedTickets = Number((await h.pool.query("SELECT COUNT(*) FROM tickets")).rows[0].count);
  const ticketRows: string[][] = parse((await csv("admin", "/api/export/tickets")).text);
  check(ticketRows.length - 1 === expectedTickets && expectedTickets > 1000, `tickets export is complete (${expectedTickets} rows)`);
  check(ticketRows.some(r => r[1] === 'Export ticket 5, "q"'), "ticket subjects with commas and quotes round trip");
  check((await csv("agent", "/api/export/tickets")).status === 403, "agent cannot export tickets");

  // Failure handling: a failure after streaming begins ends the connection abnormally, never a complete-looking short file.
  const app = express();
  let failures = 0;
  app.get("/ok", async (_req, res) => { await streamKeysetCsv(res, { filename: "t.csv", headers: ["id"], pageSize: 2,
    fetchPage: async (after, limit) => Array.from({ length: Math.min(limit, Math.max(0, 5 - after)) }, (_, i) => ({ id: after + i + 1 })),
    toRows: page => page.map(r => [r.id]) }); });
  app.get("/fail-mid", async (_req, res) => { let n = 0; try { await streamKeysetCsv(res, { filename: "t.csv", headers: ["id"], pageSize: 2,
    onStreamFailure: () => { failures++; },
    fetchPage: async (after, limit) => { if (++n === 2) throw new Error("page 2 failed"); return Array.from({ length: limit }, (_, i) => ({ id: after + i + 1 })); },
    toRows: page => page.map(r => [r.id]) }); } catch {} });
  app.get("/fail-first", async (_req, res) => { try { await streamKeysetCsv(res, { filename: "t.csv", headers: ["id"], fetchPage: async () => { throw new Error("first page failed"); }, toRows: () => [] }); } catch { res.status(500).json({ message: "unavailable" }); } });
  const server = await new Promise<any>(resolve => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    check((await (await h.originalFetch(`${base}/ok`)).text()) === '"id"\n"1"\n"2"\n"3"\n"4"\n"5"\n', "paging across a partial last page emits every row once");
    let midFailed = false;
    try { await (await h.originalFetch(`${base}/fail-mid`)).text(); } catch { midFailed = true; }
    check(midFailed && failures === 1, "a mid-stream failure aborts the transfer instead of finishing a short file");
    const first = await h.originalFetch(`${base}/fail-first`);
    check(first.status === 500, "a first-page failure is an ordinary 500, no partial body");
  } finally { server.close(); }
  console.log(`E1 exports: PASS (${checks} checks)`);
} finally { await h.close(); }
