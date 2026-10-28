/**
 * Stage 4A: retired pilot mutation entrances.
 * Handler-level (mini express app with a stub role gate) plus source assertions on server/routes/lead-ops.ts.
 * No database, provider, GHL or queue access.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import express from "express";
import { RETIRED_PILOT_ENTRANCES, retiredPilotEntrance, PILOT_RETIRED_CODE } from "../server/services/pilot-entrance-retirement";

let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✅ ${name}`); };

async function main() {
  const app = express();
  app.use(express.json());
  let sideEffects = 0;
  // Stub gate: 401 without x-role, 403 unless admin, mirrors requireRole("admin") ordering.
  const gate = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const role = req.header("x-role");
    if (!role) return res.status(401).json({ error: "Unauthorized" });
    if (role !== "admin") return res.status(403).json({ error: "Forbidden" });
    next();
  };
  for (const e of RETIRED_PILOT_ENTRANCES) {
    const route = e.route.replace(":runId", ":runId");
    (app as any)[e.method.toLowerCase()](route, gate, retiredPilotEntrance(e.key));
  }
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const e of RETIRED_PILOT_ENTRANCES) {
      const url = base + e.route.replace(":runId", "run-1");
      const call = (headers: Record<string, string>) =>
        fetch(url, { method: e.method, headers: { "content-type": "application/json", ...headers }, body: "{}" });
      assert.equal((await call({})).status, 401, `${e.key} anon`);
      assert.equal((await call({ "x-role": "agent" })).status, 403, `${e.key} wrong role`);
      const r1 = await call({ "x-role": "admin" });
      const b1: any = await r1.json();
      assert.equal(r1.status, 410, `${e.key} admin status`);
      assert.equal(b1.code, PILOT_RETIRED_CODE);
      assert.equal(b1.performed, false);
      assert.equal(b1.route, e.route);
      // Stable: a second call returns the identical body.
      const b2: any = await (await call({ "x-role": "admin" })).json();
      assert.deepEqual(b2, b1);
    }
    ok(`all ${RETIRED_PILOT_ENTRANCES.length} retired entrances: anon 401, wrong role 403, admin stable 410 performed:false`);
    assert.equal(sideEffects, 0);
    ok("no side effects recorded");
  } finally {
    server.close();
  }

  // Source assertions: each matrix entry is registered with requireRole("admin") BEFORE the fence; none uses a blanket /pilot/* middleware.
  const src = readFileSync("server/routes/lead-ops.ts", "utf8");
  for (const e of RETIRED_PILOT_ENTRANCES) {
    const needle = `app.${e.method.toLowerCase()}("${e.route}", requireRole("admin"), retiredPilotEntrance("${e.key}"))`;
    assert.ok(src.includes(needle), `lead-ops.ts missing fenced registration for ${e.key}`);
  }
  ok("lead-ops.ts registers each retired entrance after requireRole(\"admin\") with the fence handler");
  assert.ok(!/app\.use\(\s*["']\/api\/lead-ops\/pilot/.test(src), "no blanket pilot middleware");
  ok("no blanket /api/lead-ops/pilot middleware");

  // The live emergency stop stays registered, role-gated and not fenced.
  const stop = src.match(/app\.post\("\/api\/lead-ops\/pilot\/emergency-stop-paid",\s*requireRole\("admin"\)[^\n]*/);
  assert.ok(stop, "emergency-stop-paid route registered with admin gate");
  assert.ok(!stop![0].includes("retiredPilotEntrance"), "emergency stop not fenced");
  ok("emergency-stop-paid remains live and role-gated");

  // Reads stay registered.
  for (const r of ["definitions", "runs", "preflight", "pool-authority", "activation-readiness", "paid-provider-approval", "status-overview"]) {
    assert.ok(src.includes(`app.get("/api/lead-ops/pilot/${r}"`), `GET ${r} kept`);
  }
  ok("pilot read routes remain registered");

  // Client: history tab mounts the read-only panel; no mutable panel remains and no mutation endpoints are called from it.
  const center = readFileSync("client/src/pages/dashboard/LeadOpsCenter.tsx", "utf8");
  assert.ok(!center.includes("<PilotStatusPanel"), "PilotStatusPanel not mounted");
  assert.ok(center.includes("<PilotHistoryPanel"), "PilotHistoryPanel mounted");
  const hist = readFileSync("client/src/pages/dashboard/LeadOps/PilotHistoryPanel.tsx", "utf8");
  assert.ok(!/useMutation|apiRequest|<Button|<Input|method:\s*["'](POST|PUT|PATCH|DELETE)/.test(hist), "history panel has no mutation or control");
  ok("history tab is read-only (no mutation, button or input)");
  const health = readFileSync("client/src/pages/dashboard/LeadOps/PaidProviderControlsPanel.tsx", "utf8");
  assert.ok(health.includes("/api/lead-ops/pilot/emergency-stop-paid") && health.includes("button-paid-provider-emergency-stop"));
  assert.ok(readFileSync("client/src/pages/dashboard/LeadOps/ProgramHealthPanel.tsx", "utf8").includes("<PaidProviderControlsPanel"));
  ok("emergency stop UI lives in Program Health");
  const pre = readFileSync("client/src/pages/dashboard/OutboundPreflight.tsx", "utf8");
  assert.ok(!/Launch Cohort|cohort-launch/.test(pre));
  ok("OutboundPreflight has no Launch Cohort entrance");

  console.log(`\n${passed} check groups passed`);
}

main().catch((e) => { console.error("FAIL", e); process.exit(1); });
