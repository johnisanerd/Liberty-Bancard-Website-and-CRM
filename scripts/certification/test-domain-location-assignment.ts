import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { applyCertificationProviderDenyBoundary,
  getBlockedCertificationNetworkAttemptCount } from "../certification-provider-deny";
await assertDisposableTestInfrastructure({ operation: "independent domain/location assignment certification", requireRedis: false });
process.env.VG_PROVIDER_DENY_MODE = "1";
applyCertificationProviderDenyBoundary({ fatal: true });
const { db, pool } = await import("../../server/db");
const svc = await import("../../server/services/contact-business-domain-location-links");
const nonce = randomUUID().replaceAll("-", "").slice(0, 12);
const adminId = `dl-admin-${nonce}`, agentId = `dl-agent-${nonce}`;
let checks = 0;
const check = (value: unknown, message: string) => { assert(value, message); checks++; };
let seq = 0;

async function business(label: string, o: { domain?: string | null; city?: string | null; state?: string | null; source?: string | null;
  cls?: string; link?: string | null; name?: string } = {}) {
  const name = o.name ?? `Dl ${label} ${nonce} Plumbing LLC`;
  const domain = o.domain === undefined ? `${label}-${nonce}.example.test` : o.domain;
  const b = (await pool.query(`INSERT INTO businesses (canonical_name,normalized_name,website_domain,city,state,record_class,last_source_type)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [name, `${name.toLowerCase()}${seq++}`, domain,
    o.city === undefined ? "Miami" : o.city, o.state === undefined ? "FL" : o.state, o.cls ?? "canonical",
    o.source === undefined ? "serper" : o.source])).rows[0];
  if (o.link) await pool.query(`INSERT INTO canonical_source_links (business_id,source_system,source_type,stable_key) VALUES($1,$2,'place',$3)`,
    [b.id, o.link, `${nonce}-${label}-${seq++}`]);
  return { id: Number(b.id), name, domain: domain as string };
}
async function contact(label: string, b: { name: string; domain: string }, o: { email?: string | null; website?: string | null;
  city?: string | null; state?: string | null; company?: string; status?: string; businessId?: number } = {}) {
  const c = (await pool.query(`INSERT INTO contacts (first_name,last_name,phone,email,company_name,website,city,state,record_class,email_status,business_id)
    VALUES('Dl','Fixture','',$1,$2,$3,$4,$5,'production',$6,$7) RETURNING id`,
  [o.email === undefined ? `${label}.${nonce}@${b.domain}` : o.email, o.company ?? b.name.replace(/ LLC$/, ", Inc."), o.website ?? null,
    o.city === undefined ? "Miami" : o.city, o.state === undefined ? "Florida" : o.state, o.status ?? "unvalidated", o.businessId ?? null])).rows[0];
  return Number(c.id);
}
const evalIds = async (ids: number[]) => svc.evaluateDomainLocationPolicy(db, sql`c.id = ANY(ARRAY[${sql.join(ids.map(i => sql`${i}`), sql`,`)}]::int[])`);
const one = async (id: number) => (await evalIds([id]))[0];

try {
  await pool.query(`INSERT INTO users (id,email,role) VALUES($1,$2,'admin'),($3,$4,'agent')`,
    [adminId, `${nonce}@admin.example.test`, agentId, `${nonce}@agent.example.test`]);

  // Eligible: independent business, corporate domain, company identity, affirmative location; ZB status ignored.
  const bOk = await business("ok");
  const cOk = await contact("owner", bOk, { status: "invalid" });
  const cOk2 = await contact("sales", bOk, { status: "valid" });
  const r = await one(cOk);
  check(r?.eligible && r.businessId === bOk.id, "Domain, company and location agreement is eligible regardless of email status");
  const pair = await evalIds([cOk, cOk2]);
  check(pair.every(x => x.eligible) && new Set(pair.map(x => x.businessId)).size === 1, "Two contacts, one business");

  // Vertical never gates.
  await pool.query(`UPDATE businesses SET vertical=NULL WHERE id=$1`, [bOk.id]);
  check((await one(cOk)).eligible, "Missing vertical does not gate assignment");

  // Location must be affirmative.
  const bLoc = await business("loc");
  check((await one(await contact("a", bLoc, { city: null, state: null }))).reasons.includes("location_not_affirmed"), "Missing contact location is not affirmative");
  check((await one(await contact("b", bLoc, { city: "Tampa" }))).reasons.includes("location_not_affirmed"), "Different city is not agreement");
  const bNoLoc = await business("noloc", { city: null, state: null });
  check((await one(await contact("c", bNoLoc))).reasons.includes("location_not_affirmed"), "Business without location is not affirmative");

  // Company identity.
  const bName = await business("name");
  check((await one(await contact("d", bName, { company: "Different Roofing Inc" }))).reasons.includes("company_name_mismatch"), "Company mismatch blocks");

  // Shared brand: one domain, several company identities among contacts.
  const bBrand = await business("brand");
  const cBrand1 = await contact("e", bBrand);
  await contact("f", bBrand, { company: "Another Franchisee Services Inc" });
  check((await one(cBrand1)).reasons.includes("shared_brand_domain"), "Shared-brand domain is excluded");

  // Several canonical businesses on one domain.
  const bDup1 = await business("dup", {});
  await business("dup2", { domain: bDup1.domain, name: `Other ${nonce} Dental LLC` });
  const cDup = await contact("g", bDup1);
  check((await one(cDup)).reasons.includes("multiple_businesses_on_domain"), "Multiple businesses on the domain are excluded");

  // Independence and contact-derived self-corroboration.
  const bNoSrc = await business("nosrc", { source: null });
  check((await one(await contact("h", bNoSrc))).reasons.includes("business_not_independent"), "A business without independent discovery is not independent");
  const bCrm = await business("crm", { link: "crm" });
  check((await one(await contact("i", bCrm))).reasons.includes("business_contact_derived"), "A CRM-derived business cannot corroborate its own contact");
  const bProd = await business("prod", { cls: "production" });
  check((await evalIds([await contact("j", bProd)])).length === 0, "Non-canonical businesses are never candidates");
  const bReg = await business("reg", { source: null, link: "sunbiz" });
  check((await one(await contact("k", bReg))).eligible, "A registry-linked business is independent");

  // Domain contradiction between email and website.
  const bConf = await business("conf");
  check((await evalIds([await contact("l", bConf, { website: `https://other-${nonce}.example.test` })])).length === 0, "Contradictory contact domains yield no candidate");

  // Shared mailbox contact has no corporate domain.
  const bGm = await business("gm");
  check((await evalIds([await contact("m", bGm, { email: `m.${nonce}@gmail.com` })])).length === 0, "Shared mailbox alone has no domain evidence");
  check((await one(await contact("m2", bGm, { email: `m2.${nonce}@gmail.com`, website: `https://${bGm.domain}/x` }))).eligible, "Corporate website with shared mailbox is domain evidence");

  // Existing contradictory assignment.
  const bC1 = await business("c1"), bC2 = await business("c2", { name: `Unrelated ${nonce} Auto LLC` });
  await contact("n0", bC1, { businessId: bC2.id });
  const cContra = await contact("n1", bC1);
  check((await one(cContra)).reasons.includes("contradictory_existing_assignment"), "A contradictory assignment of the same identity blocks");
  const cAssigned = await contact("n2", bC1, { businessId: bC2.id });
  check((await evalIds([cAssigned])).length === 0, "Already-assigned contacts are never re-evaluated");

  // Competing same-identity business at the same location (different domain).
  const bTwinA = await business("twinA", { name: `Twin ${nonce} Realty LLC` });
  await business("twinB", { name: `Twin ${nonce} Realty LLC` });
  check((await one(await contact("o", bTwinA))).reasons.includes("competing_identity_same_location"), "Same identity at the same location competes");

  // Preview: window summary separates contacts from businesses and writes nothing.
  const events0 = (await pool.query(`SELECT count(*)::int n FROM contact_source_events`)).rows[0].n;
  const decisions0 = (await pool.query(`SELECT count(*)::int n FROM contact_business_link_decisions`)).rows[0].n;
  const preview = await svc.previewDomainLocationAssignments({ afterContactId: Math.max(0, cOk - 1), span: 5000 });
  check(preview.eligibleContacts > preview.eligibleBusinesses && preview.writes === 0 && preview.paidProviderCalls === 0,
    "Preview reports distinct contacts and businesses separately and writes nothing");
  check((await pool.query(`SELECT count(*)::int n FROM contact_source_events`)).rows[0].n === events0
    && (await pool.query(`SELECT count(*)::int n FROM contact_business_link_decisions`)).rows[0].n === decisions0, "Preview writes no evidence or decisions");

  // Apply through the audited writer.
  const item = { contactId: cOk, businessId: bOk.id, snapshotHash: r.snapshotHash };
  const denied = await svc.applyDomainLocationAssignment(item, agentId);
  check(denied.status === "rejected", "Non-administrators cannot apply");
  const stale = await svc.applyDomainLocationAssignment({ ...item, snapshotHash: "0".repeat(64) }, adminId);
  check(stale.status === "rejected" && (stale as any).code === "MATCH_CHANGED_REFRESH_PREVIEW", "A changed snapshot is refused");
  const sendsBefore = (await pool.query(`SELECT count(*)::int n FROM sequence_enrollments`)).rows[0].n;
  const applied = await svc.applyDomainLocationAssignment(item, adminId);
  check(applied.status === "applied", `Applies through the existing authority: ${JSON.stringify(applied)}`);
  const row = (await pool.query(`SELECT business_id FROM contacts WHERE id=$1`, [cOk])).rows[0];
  check(Number(row.business_id) === bOk.id, "Contact projection assigned");
  const decision = (await pool.query(`SELECT decision,reviewed_by FROM contact_business_link_decisions WHERE contact_id=$1 AND superseded_at IS NULL`, [cOk])).rows[0];
  check(decision.decision === "verified" && decision.reviewed_by === adminId, "Audited decision names the administrator");
  const replay = await svc.applyDomainLocationAssignment(item, adminId);
  check(replay.status === "replayed", "Replay is idempotent");
  check((await evalIds([cOk])).length === 0, "Assigned contact leaves the candidate set");
  const second = await svc.applyDomainLocationAssignment({ contactId: cOk2, businessId: bOk.id, snapshotHash: pair.find(x => x.contactId === cOk2)!.snapshotHash }, adminId);
  check(second.status === "applied", "Second contact on the same business applies independently");
  check((await pool.query(`SELECT count(*)::int n FROM sequence_enrollments`)).rows[0].n === sendsBefore, "Assignment enrolls nobody");
  // Automatic worker: closed by default, admin-authorized, conflicts preserved, vertical/validation ignored.
  const auto = await import("../../server/services/contact-domain-location-automation");
  const bAuto = await business("auto");
  const cAutoInvalid = await contact("ai", bAuto, { status: "invalid" });
  const cAutoUnval = await contact("au", bAuto, { status: "unvalidated" });
  const bAutoBrand = await business("autobrand");
  const cAutoBrand = await contact("ab", bAutoBrand);
  await contact("ab2", bAutoBrand, { company: "Unrelated Franchisee Group Inc" });
  const assignedFor = async (id: number) => (await pool.query(`SELECT business_id FROM contacts WHERE id=$1`, [id])).rows[0].business_id;
  check((await auto.processDomainLocationAutomationTick()).ran === false, "Automation is closed until enabled");
  check(await assignedFor(cAutoInvalid) == null, "Nothing is assigned while closed");
  await assert.rejects(() => auto.setDomainLocationAutomation(true, agentId), /ADMIN_REQUIRED/, "Only an administrator can enable automation");
  await auto.setDomainLocationAutomation(true, adminId);
  const enrollments1 = (await pool.query(`SELECT count(*)::int n FROM sequence_enrollments`)).rows[0].n;
  const tick = await auto.processDomainLocationAutomationTick();
  check(tick.ran === true && tick.committed >= 2, `Automatic tick commits eligible contacts: ${JSON.stringify(tick)}`);
  check(Number(await assignedFor(cAutoInvalid)) === bAuto.id && Number(await assignedFor(cAutoUnval)) === bAuto.id,
    "Eligible contacts are assigned regardless of email validation status");
  const autoDecision = (await pool.query(`SELECT reviewed_by,decision FROM contact_business_link_decisions WHERE contact_id=$1 AND superseded_at IS NULL`, [cAutoInvalid])).rows[0];
  check(autoDecision.reviewed_by === adminId && autoDecision.decision === "verified", "Automatic decision records the authorizing administrator");
  check(await assignedFor(cAutoBrand) == null && await assignedFor(cDup) == null && await assignedFor(cContra) == null,
    "Shared-brand, multi-business and contradictory cases are preserved, not assigned");
  check((await pool.query(`SELECT count(*)::int n FROM contact_business_link_decisions WHERE contact_id=ANY($1::int[]) AND superseded_at IS NULL`, [[cAutoBrand, cDup, cContra]])).rows[0].n === 0,
    "No decision exists for preserved conflicts");
  const state = await auto.getDomainLocationAutomationStatus();
  check(state && state.committed >= 2 && state.passes >= 1 && state.leaseToken === null && state.held > 0, "Durable progress, released lease and held reasons recorded");
  check((await auto.processDomainLocationAutomationTick()).ran === false, "A completed pass is not rescanned before the rescan interval");
  const replayedTick = await svc.applyDomainLocationAssignment({ contactId: cAutoInvalid, businessId: bAuto.id, snapshotHash: "0".repeat(64) }, adminId);
  check(replayedTick.status === "rejected", "An already-assigned contact cannot be reassigned");
  // A tick that stops on its budget keeps its place: the next tick starts after the last contact handled and
  // no contact is evaluated twice (counters rise by at most the budget each tick).
  const bResume = await business("resume");
  const cResume1 = await contact("rs1", bResume);
  const cResume2 = await contact("rs2", bResume);
  await pool.query(`UPDATE system_settings SET value=value||'{"lastPassCompletedAt":null,"cursor":0}'::jsonb WHERE key=$1`, [auto.DOMAIN_LOCATION_AUTOMATION_KEY]);
  let resumeTicks = 0, resumeCursorMax = 0, resumeWithinBudget = true;
  for (let i = 0; i < 120 && (await assignedFor(cResume1) == null || await assignedFor(cResume2) == null); i++) {
    const before = (await auto.getDomainLocationAutomationStatus())!;
    const t = await auto.processDomainLocationAutomationTick({ maxContacts: 1 });
    if (!t.ran) break;
    resumeTicks++;
    const after = (await auto.getDomainLocationAutomationStatus())!;
    if (after.scanned - before.scanned > 1) resumeWithinBudget = false;
    if (after.cursor !== 0) { check(after.cursor > before.cursor, `Budget-stopped tick advances the cursor (${before.cursor} -> ${after.cursor})`); resumeCursorMax = Math.max(resumeCursorMax, after.cursor); }
  }
  check(resumeTicks > 1 && resumeCursorMax > 0, `Partial ticks resumed across ticks: ${resumeTicks} ticks`);
  check(resumeWithinBudget, "No contact is re-evaluated by a later tick of the same pass");
  check(Number(await assignedFor(cResume1)) === bResume.id && Number(await assignedFor(cResume2)) === bResume.id, "Resumed ticks eventually assign every eligible contact");
  await auto.setDomainLocationAutomation(false, adminId);
  await pool.query(`UPDATE system_settings SET value=value||'{"lastPassCompletedAt":null}'::jsonb WHERE key=$1`, [auto.DOMAIN_LOCATION_AUTOMATION_KEY]);
  check((await auto.processDomainLocationAutomationTick()).ran === false, "Disabling stops the worker");
  check((await pool.query(`SELECT count(*)::int n FROM sequence_enrollments`)).rows[0].n === enrollments1, "Automation enrolls nobody");
  check(getBlockedCertificationNetworkAttemptCount() === 0, "No provider network attempt");
  console.log(`Independent domain/location assignment: ${checks} checks passed`);
} finally { await pool.end(); }
