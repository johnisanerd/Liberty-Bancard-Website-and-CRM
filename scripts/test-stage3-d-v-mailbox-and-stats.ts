import assert from "node:assert/strict";
import { stage3BHttpFixture } from "./fixtures/stage3-b-http";

// Two independent repairs, certified on real handlers and real transactions on a disposable database:
//  1. Every contact email change (updateContactLocalFirst: Contact PUT and incoming GHL apply callers; storage.updateContact)
//     takes the destination/source mailbox advisory lock BEFORE the contact row lock, so it serializes with other mailbox writers.
//  2. /api/dashboard/stats contacts uses the same population authority as the People list and count readers, including the
//     "linked to an agent-owned deal" branch for agents.
let checks = 0;
const check = (ok: unknown, label: string) => { assert.ok(ok, label); checks++; console.log(`✓ ${label}`); };
const h = await stage3BHttpFixture(async app => {
  const { registerContactsRoutes } = await import("../server/routes/contacts.ts");
  const { registerPermissionsAuditRoutes } = await import("../server/routes/permissions-audit.ts");
  registerContactsRoutes(app); registerPermissionsAuditRoutes(app);
  app.use("/api", (_req, res) => res.status(501).json({ message: "Unregistered isolated service" }));
});
const tag = h.prefix.slice(-12).toLowerCase();
const q = async (text: string, v: any[] = []) => (await h.pool.query(text, v)).rows;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const mailboxKey = (email: string) => `contact-mailbox:${email.trim().toLowerCase()}`;
const seed = async (label: string, o: { email?: string; assignedTo?: string | null; cls?: string; archived?: boolean } = {}) =>
  Number((await q(`INSERT INTO contacts(first_name,last_name,email,phone,company_name,record_class,assigned_to,archived_at)
    VALUES('Mbx','Fixture',$1,'',$2,$3,$4,$5) RETURNING id`,
  [o.email ?? `${label}.${tag}@example.test`, `${tag}-${label}`, o.cls ?? "production", o.assignedTo ?? null, o.archived ? new Date() : null]))[0].id);

/** Holds the mailbox advisory lock in its own transaction; the writer must wait for it. */
async function withMailboxHolder<T>(email: string, start: () => Promise<T>, expectWait = true) {
  const holder = await h.pool.connect(), probe = await h.pool.connect();
  let settled = false;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [mailboxKey(email)]);
    const run = start().then(v => { settled = true; return v; }, e => { settled = true; throw e; });
    run.catch(() => undefined);
    await sleep(1200);
    const waitedWhileHeld = !settled;
    await holder.query("COMMIT");
    const result = await run;
    return { result, waitedWhileHeld, probe };
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined); holder.release(); probe.release();
  }
}
async function rowLockFree(id: number) {
  const probe = await h.pool.connect();
  try {
    await probe.query("BEGIN");
    try { await probe.query("SELECT id FROM contacts WHERE id=$1 FOR UPDATE NOWAIT", [id]); return true; } catch { return false; }
  } finally { await probe.query("ROLLBACK").catch(() => undefined); probe.release(); }
}

try {
  const { updateContactLocalFirst, ContactWriteConflictError } = await import("../server/services/contact-writer.ts");
  const { storage } = await import("../server/storage");
  const audits = async (id: number) => Number((await q(`SELECT count(*) n FROM audit_logs WHERE entity_type='contact' AND entity_id=$1 AND action='contact_updated'`, [String(id)]))[0].n);
  const intents = async (id: number) => Number((await q(`SELECT count(*) n FROM validation_intents WHERE contact_id=$1`, [id]))[0].n);

  // ── 1a. updateContactLocalFirst directly, destination mailbox held by another transaction ──
  const a = await seed("a", { email: `a-old.${tag}@example.test` });
  const aDest = `a-new.${tag}@example.test`;
  const genBefore = Number((await q(`SELECT email_mutation_generation g FROM contacts WHERE id=$1`, [a]))[0].g);
  let freeWhileWaiting: boolean | null = null;
  const aRun = await withMailboxHolder(aDest, async () => {
    const pending = updateContactLocalFirst(a, { email: aDest } as any, { actorType: "user" });
    await sleep(600);
    freeWhileWaiting = await rowLockFree(a);
    return pending;
  });
  check(aRun.waitedWhileHeld, "updateContactLocalFirst waits while another transaction holds the destination mailbox lock");
  check(freeWhileWaiting === true, "the mailbox lock is taken before the contact row lock (row is unlocked while waiting)");
  const aAfter = (await q(`SELECT email,email_mutation_generation g,email_token_hash,email_status FROM contacts WHERE id=$1`, [a]))[0];
  check(aAfter.email === aDest && Number(aAfter.g) === genBefore + 1 && aAfter.email_token_hash && aAfter.email_status === "unvalidated",
    "after release: email changed once, validation generation advanced, token hash replaced, status reset");
  check(await audits(a) === 1 && await intents(a) <= 1, `exactly one audit row and no duplicate validation intent for the change (audits=${await audits(a)}, intents=${await intents(a)})`);

  // ── 1b. the address being left is also protected ──
  const b = await seed("b", { email: `b-old.${tag}@example.test` });
  const bRun = await withMailboxHolder(`b-old.${tag}@example.test`, () => updateContactLocalFirst(b, { email: `b-new.${tag}@example.test` } as any, { actorType: "user" }));
  check(bRun.waitedWhileHeld && (await q(`SELECT email FROM contacts WHERE id=$1`, [b]))[0].email === `b-new.${tag}@example.test`, "a change away from a held mailbox waits, then applies");

  // ── 1c. compare-and-set is preserved under the new order ──
  const c = await seed("c", { email: `c-old.${tag}@example.test` });
  let conflict = false;
  try { await updateContactLocalFirst(c, { email: `c-new.${tag}@example.test` } as any, { actorType: "system" }, { field: "email", expectedValue: "someone-else@example.test" }); }
  catch (e) { conflict = e instanceof ContactWriteConflictError; }
  check(conflict && (await q(`SELECT email FROM contacts WHERE id=$1`, [c]))[0].email === `c-old.${tag}@example.test` && await audits(c) === 0,
    "a stale compare-and-set is rejected without changing the email or writing an audit row");
  const same = await seed("same", { email: `same.${tag}@example.test` });
  await updateContactLocalFirst(same, { email: `SAME.${tag}@example.test` } as any, { actorType: "user" });
  check(Number((await q(`SELECT email_mutation_generation g FROM contacts WHERE id=$1`, [same]))[0].g) === 0 && await intents(same) === 0,
    "a case-only email change does not advance the validation generation");

  // ── 1d. Contact PUT (real route, no outer transaction) ──
  const d = await seed("d", { email: `d-old.${tag}@example.test` });
  const dDest = `d-new.${tag}@example.test`;
  const dRun = await withMailboxHolder(dDest, () => h.request("admin", "PUT", `/api/contacts/${d}`, { email: dDest }));
  check(dRun.waitedWhileHeld, "Contact PUT waits for the destination mailbox lock");
  check(dRun.result.status === 200 && (await q(`SELECT email FROM contacts WHERE id=$1`, [d]))[0].email === dDest && await audits(d) === 1,
    `Contact PUT completes after release with one audit row (${dRun.result.status})`);

  // ── 1e. generic storage update ──
  const e = await seed("e", { email: `e-old.${tag}@example.test` });
  const eDest = `e-new.${tag}@example.test`;
  const eRun = await withMailboxHolder(eDest, () => storage.updateContact(e, { email: eDest } as any, { actorType: "user" }));
  check(eRun.waitedWhileHeld && (await q(`SELECT email FROM contacts WHERE id=$1`, [e]))[0].email === eDest, "storage.updateContact waits for the destination mailbox lock and then applies");

  // ── 1f. two concurrent changes into the same mailbox are serialized, never interleaved ──
  const f1 = await seed("f1"), f2 = await seed("f2"), shared = `f-shared.${tag}@example.test`;
  const results = await Promise.allSettled([
    updateContactLocalFirst(f1, { email: shared } as any, { actorType: "user" }),
    updateContactLocalFirst(f2, { email: shared } as any, { actorType: "user" }),
  ]);
  check(results.every(r => r.status === "fulfilled") && Number((await q(`SELECT count(*) n FROM contacts WHERE lower(email)=$1`, [shared]))[0].n) === 2
    && await audits(f1) === 1 && await audits(f2) === 1, "concurrent changes into one mailbox both complete once with one audit row each and no deadlock");

  // ── 2. dashboard stats: same population authority as the People readers ──
  const { readPeople, readContactPopulationCount } = await import("../server/services/revenue-read-authority.ts");
  const agent = { role: "agent", email: h.email("agent") }, foreign = h.email("other"), admin = { role: "admin", email: h.email("admin") };
  const stats = async (role: string) => (await h.request(role, "GET", "/api/dashboard/stats")).body.contacts.total as number;
  const baseline = { agent: await stats("agent"), admin: await stats("admin"), manager: await stats("manager") };
  const assigned = await seed("stat-assigned", { assignedTo: agent.email });
  const unassigned = await seed("stat-unassigned", { assignedTo: null });
  const linked = await seed("stat-linked", { assignedTo: foreign });
  const forbiddenNoDeal = await seed("stat-forbidden", { assignedTo: foreign });
  const forbiddenArchivedDeal = await seed("stat-forbidden-archived-deal", { assignedTo: foreign });
  await seed("stat-archived", { assignedTo: agent.email, archived: true });
  await seed("stat-nonprod", { assignedTo: agent.email, cls: "test" });
  await q(`INSERT INTO deals(contact_id,pipeline,stage,record_class,owner) VALUES($1,'sales','New Lead','production',$2)`, [linked, agent.email]);
  await q(`INSERT INTO deals(contact_id,pipeline,stage,record_class,owner,archived_at) VALUES($1,'sales','New Lead','production',$2,NOW())`, [forbiddenArchivedDeal, agent.email]);
  const agentStats = await h.request("agent", "GET", "/api/dashboard/stats");
  check(agentStats.status === 200 && agentStats.body.contacts.total - baseline.agent === 3,
    `agent stats add exactly assigned + unassigned + linked-to-owned-deal (+${agentStats.body.contacts.total - baseline.agent})`);
  check(/linked to a deal they own/.test(agentStats.body.populations.contacts.label), "the label still states the owned-deal branch, and the number now matches it");
  const search = { search: `${tag}-stat-` };
  const agentList = await readPeople(agent, { limit: 100, offset: 0, recordClass: "production", ...search });
  const listed = new Set(agentList.data.map((r: any) => Number(r.id)));
  check(listed.size === 3 && [assigned, unassigned, linked].every(id => listed.has(id)) && ![forbiddenNoDeal, forbiddenArchivedDeal].some(id => listed.has(id)),
    `the agent's People list (${[...listed].join(",")} vs ${[assigned, unassigned, linked, forbiddenNoDeal, forbiddenArchivedDeal].join(",")}) contains the same three fixtures and excludes foreign, archived-deal, archived and non-production rows`);
  check(await readContactPopulationCount(agent, { recordClass: "production", ...search }) === 3, "the shared count reader agrees with the list for the same filters");
  check(await stats("admin") - baseline.admin === 5 && await stats("manager") - baseline.manager === 5,
    "admin and manager stats count all five production, non-archived fixtures");
  check(await readContactPopulationCount(admin, { recordClass: "production", ...search }) === 5, "admin count reader agrees for the same filters");
  const forbiddenStats = await h.request("merchant", "GET", "/api/dashboard/stats");
  check(forbiddenStats.status === 401 || forbiddenStats.status === 403, `merchant stats stay denied (${forbiddenStats.status})`);
  console.log(`Stage 3 D-V mailbox protocol and stats parity: PASS (${checks} checks)`);
} finally { await h.close(); }
