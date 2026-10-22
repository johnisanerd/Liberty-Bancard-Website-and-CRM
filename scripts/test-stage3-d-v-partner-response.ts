import assert from "node:assert/strict";
import { stage3BHttpFixture } from "./fixtures/stage3-b-http";
import { PARTNER_OPERATOR_FIELDS } from "../shared/partner-response";

// Partner credential exposure: every HTTP boundary that returns a partner record goes through the explicit allowlist.
// Actual registered handlers, populated FAKE credential values, a fake future internal column, success and error bodies,
// every role. Credential values never appear in assertion messages (only key names and counts are reported).
let checks = 0;
const check = (ok: unknown, label: string) => { assert.ok(ok, label); checks++; console.log(`✓ ${label}`); };
const SENTINELS = ["SENTINEL-PW-HASH-9f2c", "SENTINEL-RESET-TOKEN-71ab", "SENTINEL-INVITE-TOKEN-c04d", "SENTINEL-FUTURE-INTERNAL-5e19", "SENTINEL-PAYPAL-3b77"];
const FORBIDDEN_KEY = /pass|token|secret|hash|invite|reset|credential|api.?key|paypal/i;
const h = await stage3BHttpFixture(async app => {
  const { registerPartnersRoutes } = await import("../server/routes/partners.ts");
  const { registerOnboardingStagesRoutes } = await import("../server/routes/onboarding-stages.ts");
  registerPartnersRoutes(app); registerOnboardingStagesRoutes(app);
  app.use("/api", (_req, res) => res.status(501).json({ message: "Unregistered isolated service" }));
});
function keysOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach(v => keysOf(v, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.push(k); keysOf(v, out); }
  return out;
}
function assertClean(body: unknown, label: string) {
  const text = JSON.stringify(body);
  const badKeys = [...new Set(keysOf(body).filter(k => FORBIDDEN_KEY.test(k)))];
  const leaked = SENTINELS.filter(s => text.includes(s)).length;
  check(badKeys.length === 0 && leaked === 0, `${label}: no credential key (${badKeys.join(",") || "none"}) and ${leaked} sentinel values`);
}
const tag = h.prefix.slice(-8).toLowerCase();
const adminRead = async (path: string) => h.request("admin", "GET", path);
try {
  const mk = async (name: string, extra: Record<string, unknown> = {}) => (await h.pool.query(
    `INSERT INTO partners(company_name,contact_name,email,phone,password_hash,password_reset_token,password_reset_expires_at,invite_token,invite_token_expires_at,
       paypal_email,partner_type,affiliate_code,status,referral_owner,commission_status,notes)
     VALUES($1,'Pat Partner',$2,'5550100',$3,$4,NOW()+interval '1 day',$5,NOW()+interval '1 day',$6,'referral',$7,'active',$8,'pending','Plain note') RETURNING id`,
    [name, `${h.prefix}-${name}@example.test`, SENTINELS[0], SENTINELS[1], SENTINELS[2], SENTINELS[4], `${tag}-${name}`.toLowerCase(), extra.owner ?? null])).rows[0].id as number;
  const pA = await mk("PartnerA", { owner: h.email("admin") });
  const pB = await mk("PartnerB");
  const pOnlyBad = await mk("PartnerOnlyBad"), pAllGood = await mk("PartnerAllGood");

  // Pipeline fixture: 12 referred contacts x 7 open production deals, a repeated referral, and excluded deals.
  const cIds: number[] = [];
  for (let i = 0; i < 12; i++) cIds.push((await h.pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,record_class) VALUES('Ref','C${i}',$1,'','production') RETURNING id`, [`${h.prefix}-ref-${i}@example.test`])).rows[0].id);
  for (const c of cIds) await h.pool.query(`INSERT INTO referrals(partner_id,contact_id,status) VALUES($1,$2,'pending')`, [pA, c]);
  await h.pool.query(`INSERT INTO referrals(partner_id,contact_id,status) VALUES($1,$2,'pending')`, [pA, cIds[0]]);
  const deal = (c: number, o: { stage?: string; cls?: string; pipeline?: string; archived?: boolean; volume?: string }) => h.pool.query(
    `INSERT INTO deals(contact_id,pipeline,stage,record_class,total_volume,archived_at) VALUES($1,$2,$3,$4,$5,$6)`,
    [c, o.pipeline ?? "sales", o.stage ?? "Negotiation / Follow-Up", o.cls ?? "production", o.volume ?? "1000", o.archived ? new Date() : null]);
  for (const c of cIds) for (let k = 0; k < 7; k++) await deal(c, {});
  // Amount contract cases on open production sales deals: accepted formats add to the total; blank and invalid amounts
  // are counted as unknown deals and never summed as zero.
  await deal(cIds[0], { volume: "$1,000" });                       // valid: currency + comma grouping
  await deal(cIds[0], { volume: "1,250.50" });                     // valid: grouping + decimals
  await deal(cIds[1], { volume: "1x25" });                         // invalid (a wildcard dot would have cast this)
  await deal(cIds[1], { volume: "1.2.3" });                        // invalid: repeated decimal separator
  await deal(cIds[1], { volume: "1,00" });                         // invalid: malformed grouping
  await deal(cIds[1], { volume: "" });                             // blank: unknown
  await deal(cIds[0], { archived: true, volume: "5000" });         // excluded
  await deal(cIds[0], { cls: "test", volume: "5000" });            // excluded
  await deal(cIds[0], { cls: "unknown", volume: "5000" });         // excluded
  await deal(cIds[0], { stage: "Closed Won", volume: "7000" });    // excluded (not open)
  await deal(cIds[0], { pipeline: "onboarding", stage: "New Lead", volume: "9000" }); // excluded (not sales pipeline)

  const oneRef = async (partner: number, tagName: string, volumes: string[]) => {
    const cid = (await h.pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,record_class) VALUES('Ref',$1,$2,'','production') RETURNING id`, [tagName, `${h.prefix}-${tagName}@example.test`])).rows[0].id;
    await h.pool.query(`INSERT INTO referrals(partner_id,contact_id,status) VALUES($1,$2,'pending')`, [partner, cid]);
    for (const v of volumes) await deal(cid, { volume: v });
  };
  await oneRef(pOnlyBad, "onlybad", ["1x25", ""]);
  await oneRef(pAllGood, "allgood", ["$100", "200"]);

  // ── Success shapes, admin ──
  const list = await adminRead("/api/partners");
  check(list.status === 200 && Array.isArray(list.body) && list.body.length >= 2, "GET /api/partners succeeds for admin");
  assertClean(list.body, "GET /api/partners");
  check(list.headers.get("cache-control") === "private, no-store", "partner list is private and not stored");
  const rowA = (list.body as any[]).find(p => p.id === pA);
  check(rowA && rowA.companyName === "PartnerA" && rowA.email && rowA.status === "active" && rowA.notes === "Plain note" && rowA.affiliateCode, "list keeps the approved UI fields");
  check(Object.keys(rowA).every(k => (PARTNER_OPERATOR_FIELDS as readonly string[]).includes(k)), "list contains only allowlisted keys");
  const detail = await adminRead(`/api/partners/${pA}`);
  check(detail.status === 200 && detail.body.id === pA && detail.body.contactName === "Pat Partner", "GET /api/partners/:id keeps approved fields");
  assertClean(detail.body, "GET /api/partners/:id");

  const created = await h.request("admin", "POST", "/api/partners", { companyName: "CreatedCo", email: `${h.prefix}-created@example.test`, status: "pending",
    passwordHash: SENTINELS[0], inviteToken: SENTINELS[2], affiliateCode: `${tag}-created` });
  check(created.status === 201 && created.body.companyName === "CreatedCo" && created.body.id, "POST /api/partners creates and returns the approved record");
  assertClean(created.body, "POST /api/partners");
  const stored = (await h.pool.query(`SELECT password_hash,invite_token FROM partners WHERE id=$1`, [created.body.id])).rows[0];
  check(stored.password_hash === SENTINELS[0] && stored.invite_token === SENTINELS[2], "authentication storage is unchanged by the response boundary");

  const patched = await h.request("admin", "PATCH", `/api/partners/${pA}`, { status: "suspended", commissionPercent: 12, notes: "Edited" });
  check(patched.status === 200 && patched.body.status === "suspended" && patched.body.commissionPercent === 12 && patched.body.notes === "Edited", "PATCH /api/partners/:id returns the updated approved fields");
  assertClean(patched.body, "PATCH /api/partners/:id");
  const tracking = await h.request("manager", "PATCH", `/api/partners/${pA}/tracking`, { commissionStatus: "approved", partnerCategory: "referral", notes: "Tracked" });
  check(tracking.status === 200 && tracking.body.commissionStatus === "approved" && tracking.body.notes === "Tracked", "PATCH tracking returns the updated approved fields");
  assertClean(tracking.body, "PATCH /api/partners/:id/tracking");

  const pipeline = await h.request("manager", "GET", "/api/partners/referral-pipeline");
  check(pipeline.status === 200 && Array.isArray(pipeline.body), "GET referral-pipeline succeeds for manager");
  assertClean(pipeline.body, "GET /api/partners/referral-pipeline");
  const pr = (pipeline.body as any[]).find(p => p.id === pA), pq = (pipeline.body as any[]).find(p => p.id === pB);
  check(pr.referredMerchantCount === 13, "referral count includes the repeated referral");
  check(pr.openPipelineDealCount === 90 && pr.openPipelineVolume === 86250.5 && pr.openPipelineVolumeUnknownDeals === 4 && pr.openPipelineVolumeStatus === "partial",
    `open pipeline covers all 12 referred contacts and all deals (90 deals: 86250.5 known volume, 4 without a usable amount, partial), each deal once; excludes archived/test/unknown/closed/onboarding rows; got ${pr.openPipelineDealCount}/${pr.openPipelineVolume}/${pr.openPipelineVolumeUnknownDeals}/${pr.openPipelineVolumeStatus}`);
  check(pq.openPipelineVolumeStatus === "complete" && pq.openPipelineVolume === 0, "a partner with no open deals is a complete zero, not partial");
  const pc = (pipeline.body as any[]).find(p => p.id === pOnlyBad), pd = (pipeline.body as any[]).find(p => p.id === pAllGood);
  check(pc.openPipelineVolume === null && pc.openPipelineVolumeStatus === "unavailable" && pc.openPipelineVolumeUnknownDeals === 2 && pc.openPipelineDealCount === 2,
    "a partner whose open deals all have unusable amounts is Unavailable (null), never a certified zero");
  check(pd.openPipelineVolume === 300 && pd.openPipelineVolumeStatus === "complete" && pd.openPipelineVolumeUnknownDeals === 0, "a partner whose open deals all have valid amounts is complete");
  const { parseStoredAmount, STORED_AMOUNT_PATTERN } = await import("../shared/amount-contract");
  const samples = ["1000", "$1,000", "1,250.50", "-5", "$-5", "0.5", ".5", "1x25", "1.2.3", "1,00", "1,0000", "abc", "", "  ", "12 000", "1e5", "$", "1,000,000.00"];
  const sqlVerdicts = (await h.pool.query(`SELECT s, btrim(s) ~ $2 AS valid FROM unnest($1::text[]) s`, [samples, STORED_AMOUNT_PATTERN])).rows;
  check(sqlVerdicts.every((r: any) => (parseStoredAmount(r.s).state === "valid") === r.valid), "the TypeScript amount contract and the SQL pattern agree on every sample");
  check(!STORED_AMOUNT_PATTERN.includes(String.fromCharCode(92)) && STORED_AMOUNT_PATTERN.includes("[.]"), "the shared pattern uses a bracketed literal dot and no backslash escapes");
  const analytics = await h.pool.query(`SELECT COALESCE(SUM(CASE WHEN btrim(v) ~ $2 THEN regexp_replace(btrim(v),'[$,]','','g')::numeric END),0)::float8 t FROM unnest($1::text[]) v`, [["$1,000", "1x25", "1,250.50", ""], STORED_AMOUNT_PATTERN]);
  check(analytics.rows[0].t === 2250.5, "the shared SQL expression totals mixed input without a cast failure");
  check(pq.referredMerchantCount === 0 && pq.openPipelineVolume === 0 && pq.openPipelineDealCount === 0, "a partner with no referrals shows empty aggregates");
  check(pr.nextFollowupDue === null || typeof pr.nextFollowupDue === "string", "next follow-up stays a plain date or null");
  check(!("pipelineValue" in pr), "the old mixed-stage sampled pipelineValue is gone");

  const link = await h.request("manager", "POST", "/api/partners/link-referral", { referralSource: "PartnerB", referredName: "Linked Lead", referredEmail: `${h.prefix}-linked@example.test` });
  check(link.status === 200 && link.body.partner?.companyName === "PartnerB" && link.body.referral, "POST link-referral returns the referral and the approved partner fields");
  assertClean(link.body, "POST /api/partners/link-referral");

  // ── Future internal property on a storage result ──
  const { storage } = await import("../server/storage");
  const originals = { getPartners: storage.getPartners, getPartner: storage.getPartner, updatePartner: storage.updatePartner };
  const poison = (p: any) => p && ({ ...p, futureInternalSecret: SENTINELS[3], privateApiKey: SENTINELS[3] });
  (storage as any).getPartners = async () => (await originals.getPartners.call(storage)).map(poison);
  (storage as any).getPartner = async (id: number) => poison(await originals.getPartner.call(storage, id));
  (storage as any).updatePartner = async (id: number, u: any) => poison(await originals.updatePartner.call(storage, id, u));
  try {
    for (const [role, method, path, body] of [["admin", "GET", "/api/partners"], ["admin", "GET", `/api/partners/${pA}`],
      ["admin", "PATCH", `/api/partners/${pA}`, { notes: "Future" }], ["manager", "PATCH", `/api/partners/${pA}/tracking`, { notes: "Future" }],
      ["manager", "GET", "/api/partners/referral-pipeline"]] as const) {
      const r = await h.request(role, method, path, body);
      check(r.status === 200, `${method} ${path} succeeds with a poisoned storage result`);
      assertClean(r.body, `${method} ${path} with a future internal property`);
    }
    const created2 = await h.request("admin", "POST", "/api/partners", { companyName: "FutureCo", email: `${h.prefix}-future@example.test`, affiliateCode: `${tag}-future` });
    check(created2.status === 201, "POST succeeds (create does not use the poisoned reads)");
    assertClean(created2.body, "POST /api/partners");
    (storage as any).getPartners = async () => { throw new Error(`boom ${SENTINELS[0]} password_hash`); };
    const failed = await h.request("manager", "GET", "/api/partners/referral-pipeline");
    check(failed.status >= 500, "a storage failure returns an error status");
    assertClean(failed.body, "pipeline error response");
  } finally { Object.assign(storage, originals); }

  // ── Error bodies ──
  const dup = await h.request("admin", "POST", "/api/partners", { companyName: "DupCo", email: `${h.prefix}-dup@example.test`, passwordHash: SENTINELS[0],
    affiliateCode: `${tag}-created` });
  check(dup.status === 409 || dup.status === 400, `duplicate affiliate code is refused (${dup.status})`);
  assertClean(dup.body, "POST duplicate error");
  const bad = await h.request("admin", "POST", "/api/partners", { companyName: 5, passwordHash: SENTINELS[0] });
  check(bad.status === 400, "invalid create body is refused");
  assertClean(bad.body, "POST validation error");
  assertClean((await h.request("admin", "GET", "/api/partners/999999")).body, "GET missing partner");
  assertClean((await h.request("manager", "PATCH", "/api/partners/999999/tracking", { notes: "x" })).body, "PATCH tracking missing partner");

  // ── Role matrix ──
  const agentList = await h.request("agent", "GET", "/api/partners");
  check(agentList.status === 200, "agents keep their existing safe list access");
  assertClean(agentList.body, "agent GET /api/partners");
  assertClean((await h.request("agent", "GET", `/api/partners/${pA}`)).body, "agent GET /api/partners/:id");
  for (const [role, method, path, body] of [
    ["agent", "GET", "/api/partners/referral-pipeline"], ["agent", "PATCH", `/api/partners/${pA}/tracking`, { notes: "x" }],
    ["agent", "POST", "/api/partners", { companyName: "X" }], ["agent", "PATCH", `/api/partners/${pA}`, { notes: "x" }],
    ["manager", "POST", "/api/partners", { companyName: "X" }], ["manager", "PATCH", `/api/partners/${pA}`, { notes: "x" }],
    ["merchant", "GET", "/api/partners"], ["merchant", "GET", "/api/partners/referral-pipeline"], ["partner", "GET", "/api/partners"],
    ["affiliate", "GET", "/api/partners/referral-pipeline"], ["none", "GET", "/api/partners"], ["none", "GET", "/api/partners/referral-pipeline"],
  ] as const) {
    const r = await h.request(role, method, path, body);
    check(r.status === 401 || r.status === 403, `${role} ${method} ${path} is denied (${r.status})`);
    assertClean(r.body, `${role} ${method} ${path} denial body`);
  }
  // ── Authentication storage untouched by every operation above ──
  const after = (await h.pool.query(`SELECT password_hash,password_reset_token,invite_token FROM partners WHERE id=$1`, [pA])).rows[0];
  check(after.password_hash === SENTINELS[0] && after.password_reset_token === SENTINELS[1] && after.invite_token === SENTINELS[2], "stored credentials are unchanged by reads, updates and the allowlist");
  console.log(`Stage 3 D-V partner response: PASS (${checks} checks)`);
} finally { await h.close(); }
