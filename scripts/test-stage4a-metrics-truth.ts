/** Stage 4A F10: metric truth. Pure derivations, source assertions, and fixture-prefixed dev reads (no provider calls). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pool } from "../server/db";
import { storage } from "../server/storage";
import { resolveSdrStage } from "../server/services/sdr/stage-precedence";
import { classifySdrEventKind, countSdrEventKinds } from "../server/services/sdr/event-kinds";
import { getSdrEventKindCensus } from "../server/services/sdr/funnel-metrics";
import { handleMessageReceived } from "../server/services/sdr/webhook-handlers";
import { getPaidProviderControls, IN_FLIGHT_SAMPLE_LIMIT } from "../server/services/paid-provider-control";

let n = 0;
const ok = (m: string) => { n++; console.log(`  ✅ ${m}`); };
const src = (p: string) => readFileSync(p, "utf8");
const PREFIX = `stage4a-f10-${Date.now()}`;

async function main() {
  // 1. SDR stage precedence: agree / default stage / conflict.
  assert.deepEqual(resolveSdrStage({ stage: "QUALIFIED", currentStage: "QUALIFIED" }), { stage: "QUALIFIED", source: "agree", conflict: false });
  const adv = resolveSdrStage({ stage: "DISCOVERED", currentStage: "MEETING_SET" });
  assert.equal(adv.stage, "MEETING_SET"); assert.equal(adv.conflict, true); assert.equal(adv.source, "current_stage_advanced");
  const conflict = resolveSdrStage({ stage: "STATEMENT_REQUESTED", currentStage: "ENGAGED" });
  assert.equal(conflict.stage, "STATEMENT_REQUESTED"); assert.equal(conflict.conflict, true);
  assert.equal(resolveSdrStage({ stage: null, currentStage: "ENGAGED" }).stage, "ENGAGED");
  assert.equal(resolveSdrStage({ stage: "ENGAGED", currentStage: null }).conflict, false);
  assert.ok(!/stage \|\| s\.leadState\.currentStage/.test(src("server/storage/sdr.ts")), "old || precedence removed");
  ok("SDR stage precedence is explicit; conflicts are reported; default stage never masks an advanced currentStage");

  // 2. Event kinds stay separate.
  assert.equal(classifySdrEventKind("opt_out"), "opt_out");
  assert.equal(classifySdrEventKind("email_bounce"), "bounce");
  assert.equal(classifySdrEventKind("message_received", { direction: "inbound", body: "STOP" }), "opt_out");
  assert.equal(classifySdrEventKind("message_received", { direction: "inbound", body: "Yes please call me" }), "reply");
  assert.equal(classifySdrEventKind("message_received", { status: "undelivered", direction: "inbound" }), "delivery_failure");
  assert.equal(classifySdrEventKind("message_received", { status: "delivered" }), "delivery");
  assert.equal(classifySdrEventKind("message_received", { direction: "outbound" }), "other");
  const counts = countSdrEventKinds([
    { eventType: "message_received", payloadJson: { direction: "inbound", body: "stop" }, n: 3 },
    { eventType: "message_received", payloadJson: { direction: "inbound", body: "hello" }, n: 5 },
    { eventType: "email_bounce", n: 2 },
    { eventType: "message_received", payloadJson: { status: "failed" }, n: 4 },
  ]);
  assert.deepEqual(counts, { reply: 5, opt_out: 3, bounce: 2, delivery_failure: 4, delivery: 0, other: 0 });
  const wh = src("server/services/sdr/webhook-handlers.ts");
  assert.match(wh, /merchant && isGenuineReply/);
  ok("reply / opt-out / bounce / delivery are classified separately and a delivery failure no longer stamps lastReplyAt");

  // 3. Census labels scope, as-of, availability (live dev read; read-only).
  const census = await getSdrEventKindCensus(30);
  assert.equal(census.available, true);
  assert.ok(census.asOf && census.scope.includes("trailing 30 days"));
  assert.ok(census.counts && Object.values(census.counts).every((v) => Number.isInteger(v) && v >= 0));
  ok("event-kind census carries scope/as-of/availability");

  // 4. healthScore: 0 stays 0, null stays unknown.
  const fm = src("server/services/sdr/funnel-metrics.ts");
  assert.ok(!/healthScore \|\| 100/.test(fm), "no healthScore || 100 in funnel-metrics");
  assert.ok(!/healthScore \|\| 100/.test(src("server/services/sdr/operator-digest.ts")), "no healthScore || 100 in operator-digest");
  assert.match(fm, /healthScore: identity\.healthScore \?\? null/);
  assert.match(src("server/services/sdr/operator-digest.ts"), /i\.healthScore != null && i\.healthScore < 50/);
  assert.match(fm, /channelCountsAvailable/);
  ok("healthScore null-vs-zero and failed-read channel counts are handled");

  // 5. Step totals derive from grouped counts (0 / 1 / many) for sequences and campaigns.
  const seqIds: number[] = []; const campIds: number[] = [];
  try {
    for (const steps of [0, 1, 3]) {
      const s = await pool.query(`INSERT INTO follow_up_sequences(name,total_steps) VALUES ($1, 99) RETURNING id`, [`${PREFIX}-seq-${steps}`]);
      seqIds.push(s.rows[0].id);
      for (let i = 1; i <= steps; i++) await pool.query(`INSERT INTO sequence_steps(sequence_id,step_order,action_type) VALUES ($1,$2,'email')`, [s.rows[0].id, i]);
      const c = await pool.query(`INSERT INTO campaigns(name,total_steps) VALUES ($1, 99) RETURNING id`, [`${PREFIX}-camp-${steps}`]);
      campIds.push(c.rows[0].id);
      for (let i = 1; i <= steps; i++) await pool.query(`INSERT INTO campaign_steps(campaign_id,step_order,step_type) VALUES ($1,$2,'email')`, [c.rows[0].id, i]);
    }
    const seqs = await storage.getFollowUpSequences();
    const camps = await storage.getCampaigns();
    [0, 1, 3].forEach((steps, i) => {
      assert.equal(seqs.find((x) => x.id === seqIds[i])!.totalSteps, steps, `sequence ${steps} steps`);
      assert.equal(camps.find((x) => x.id === campIds[i])!.totalSteps, steps, `campaign ${steps} steps`);
    });
    // delete a step: derived total follows
    await pool.query(`DELETE FROM sequence_steps WHERE sequence_id=$1 AND step_order=3`, [seqIds[2]]);
    assert.equal((await storage.getFollowUpSequences()).find((x) => x.id === seqIds[2])!.totalSteps, 2);
    const rep = await pool.query(`SELECT id,total_steps FROM (${(await import("../server/services/sequence-report-query")).SEQUENCE_REPORT_SQL}) q WHERE id = ANY($1)`, [seqIds]);
    assert.deepEqual(Object.fromEntries(rep.rows.map((r: any) => [r.id, r.total_steps])), { [seqIds[0]]: 0, [seqIds[1]]: 1, [seqIds[2]]: 2 });
  } finally {
    for (const id of seqIds) { await pool.query(`DELETE FROM sequence_steps WHERE sequence_id=$1`, [id]); await pool.query(`DELETE FROM follow_up_sequences WHERE id=$1`, [id]); }
    for (const id of campIds) { await pool.query(`DELETE FROM campaign_steps WHERE campaign_id=$1`, [id]); await pool.query(`DELETE FROM campaigns WHERE id=$1`, [id]); }
  }
  assert.ok(!/s\.total_steps/.test(src("server/routes/campaigns.ts")), "vertical-coverage no longer selects stored total_steps");
  ok("step totals are derived from grouped counts and ignore the stale stored column");

  // 6. Provider-operation sample is labelled and the count is whole-population.
  const ppc = await getPaidProviderControls();
  assert.equal(ppc.inFlightSample.limit, IN_FLIGHT_SAMPLE_LIMIT);
  assert.equal(ppc.inFlightCount, ppc.inFlightSample.total);
  assert.ok(ppc.inFlightSample.returned <= IN_FLIGHT_SAMPLE_LIMIT);
  assert.equal(ppc.inFlightSample.truncated, ppc.inFlightSample.total > ppc.inFlightSample.returned);
  assert.ok(ppc.inFlightSample.asOf);
  ok("in-flight operation sample is labelled; count is the whole population");

  // 7. Local-link wording and contact-page DTO.
  const integ = src("server/routes/integrations.ts");
  assert.match(integ, /linked ID recorded locally; current native existence unverified/);
  assert.match(integ, /nativeExistence: "unverified"/);
  assert.match(integ, /outgoingControl/);
  assert.match(src("server/routes/lead-ops.ts"), /crosswalkOnlyExcluded: crosswalkOnlyExcluded \?\? null/);
  ok("local link wording, outgoing-control read and unavailable-not-zero crosswalk are in the contract");
  // 8. Webhook-to-state: only a genuine inbound reply stamps lastReplyAt (which feeds "engaged").
  const whIds: number[] = [];
  try {
    const cases: Array<{ label: string; payload: Record<string, unknown>; stamped: boolean }> = [
      { label: "failed SMS", payload: { type: "SMS", direction: "outbound", status: "failed" }, stamped: false },
      { label: "failed email", payload: { type: "Email", direction: "outbound", status: "failed", body: "x" }, stamped: false },
      { label: "undelivered inbound-labelled email", payload: { type: "Email", direction: "inbound", deliveryStatus: "undelivered" }, stamped: false },
      { label: "delivered outbound", payload: { type: "SMS", direction: "outbound", status: "delivered", body: "hello" }, stamped: false },
      { label: "inbound STOP", payload: { type: "SMS", direction: "inbound", body: "STOP" }, stamped: false },
      { label: "genuine inbound reply", payload: { type: "SMS", direction: "inbound", body: "" }, stamped: true },
    ];
    for (const [i, c] of cases.entries()) {
      const ghlId = `${PREFIX}-wh-${i}`;
      const m = await pool.query(`INSERT INTO sdr_merchants(business_name, ghl_contact_id) VALUES ($1,$2) RETURNING id`, [`${PREFIX}-wh-${i}`, ghlId]);
      whIds.push(m.rows[0].id);
      await pool.query(`INSERT INTO sdr_lead_state(merchant_id) VALUES ($1)`, [m.rows[0].id]);
      await handleMessageReceived({ contactId: ghlId, messageId: `${PREFIX}-msg-${i}`, ...c.payload });
      const st = (await pool.query(`SELECT last_reply_at, current_stage FROM sdr_lead_state WHERE merchant_id=$1`, [m.rows[0].id])).rows[0];
      assert.equal(st.last_reply_at !== null, c.stamped, `${c.label}: lastReplyAt ${c.stamped ? "stamped" : "untouched"}`);
      assert.equal(st.current_stage, "DISCOVERED", `${c.label}: stage unchanged`);
    }
  } finally {
    for (const id of whIds) {
      await pool.query(`DELETE FROM sdr_lead_events WHERE merchant_id=$1`, [id]);
      await pool.query(`DELETE FROM sdr_lead_state WHERE merchant_id=$1`, [id]);
      await pool.query(`DELETE FROM sdr_merchants WHERE id=$1`, [id]);
    }
    await pool.query(`DELETE FROM sdr_lead_events WHERE merchant_id IS NULL AND payload_json::text LIKE $1`, [`%${PREFIX}%`]);
  }
  ok("webhook-to-state: failed SMS/email, delivered outbound and STOP never stamp lastReplyAt; a genuine reply does");
}

main().then(() => { console.log(`\n${n} check groups passed`); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
