import assert from "node:assert/strict";
import fs from "node:fs";
import { decodeQueueHolds, reconciliationDiverges } from "../shared/queue-holds-dto";
import { GHL_OWNERSHIP_STATEMENT, GHL_OWNERSHIP_SUMMARY } from "../shared/ghl-ownership-guidance";

// C5 R02/R03/R04/R05 diagnostics contract proof: deterministic and static. No database, provider, Redis or server.
const read = (p: string) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// ── R02: Queue Holds decoder (real coordinator shape: record of hold arrays, array of reconciliations) ──
const hold = (id: string, key: string) => ({ holdId: id, logicalJobKey: key, reasonCode: "global_pause", sourceType: "pause", sourceKey: "k", sourceEpoch: "12", ledgerEpoch: "9007199254740993", active: true });
const base = {
  status: "ok",
  ledgerEpoch: "9007199254740993",
  desiredLogicalHolds: { "sequence-send": [hold("h2", "sequence-send"), hold("h1", "sequence-send")], "campaign-send": [hold("h3", "campaign-send")] },
  physicalQueueStates: [{ physicalQueue: "q-a", desiredState: "paused", observedState: "paused", outcome: "converged", desiredEpoch: "5", observedEpoch: "5", error: null }],
  pause: { state: "paused", source: "database", reason: "launch", epoch: "7", committedAt: "2026-10-20T00:00:00.000Z", asOf: "2026-10-20T00:01:00.000Z" },
};
const ok = decodeQueueHolds(base);
assert.equal(ok.kind, "ok");
if (ok.kind === "ok") {
  assert.deepEqual(ok.holds.map(h => h.holdId), ["h3", "h1", "h2"], "flattened, sorted by logical key then hold id");
  assert.equal(ok.ledgerEpoch, "9007199254740993", "decimal-string epoch preserved beyond Number precision");
  assert.equal(ok.pause?.state, "paused");
  assert.equal(ok.reconciliation[0].physicalQueue, "q-a");
  assert.equal(reconciliationDiverges(ok.reconciliation[0]), false);
}
assert.equal(decodeQueueHolds({ ...base, desiredLogicalHolds: [] }).kind, "malformed", "an array of holds is the old, wrong contract");
assert.equal(decodeQueueHolds({ ...base, physicalQueueStates: { "q-a": { paused: true } } }).kind, "malformed", "a keyed physical record is malformed");
assert.equal(decodeQueueHolds({ ...base, ledgerEpoch: 1.5 }).kind, "malformed");
assert.equal(decodeQueueHolds(null).kind, "malformed");
assert.equal(decodeQueueHolds({ ...base, status: "mystery" }).kind, "malformed");
const unknownObserved = decodeQueueHolds({ ...base, physicalQueueStates: [{ ...base.physicalQueueStates[0], observedState: "weird", observedEpoch: null }] });
assert.equal(unknownObserved.kind, "ok");
if (unknownObserved.kind === "ok") {
  assert.equal(unknownObserved.reconciliation[0].observedState, "unknown", "unrecognized observed state stays unknown");
  assert.equal(reconciliationDiverges(unknownObserved.reconciliation[0]), true, "unknown is never healthy");
}
const degraded = decodeQueueHolds({ ...base, status: "degraded", errorCode: "redis_down", pause: undefined, pauseUnavailable: "pause authority unreadable" });
assert.equal(degraded.kind, "degraded");
if (degraded.kind === "degraded") {
  assert.equal(degraded.pause, null);
  assert.match(degraded.pauseUnavailable ?? "", /unreadable/);
}
const diverged = decodeQueueHolds({ ...base, physicalQueueStates: [{ ...base.physicalQueueStates[0], observedState: "running" }] });
if (diverged.kind === "ok") assert.equal(reconciliationDiverges(diverged.reconciliation[0]), true, "desired paused vs observed running diverges");

const holdsPage = read("client/src/pages/queue-holds.tsx");
assert.ok(holdsPage.includes("decodeQueueHolds"), "page decodes through the shared decoder");
assert.ok(!/\.desiredLogicalHolds\.map|\(t\.desiredLogicalHolds/.test(holdsPage), "page never maps the keyed record");
const adminRoutes = read("server/routes/admin.ts");
const holdsRoute = adminRoutes.slice(adminRoutes.indexOf('"/api/admin/queue-holds"'), adminRoutes.indexOf('"/api/admin/queue-holds"') + 2500);
assert.ok(holdsRoute.includes("getPauseState"), "queue-holds read returns canonical pause facts");
assert.ok(!/reconcile\(|resume\(|releaseHold|clearHold/.test(holdsRoute), "queue-holds read performs no write or reconcile");

// ── R03: readiness registry and schema contracts (source assertions: the module imports the database eagerly) ──
const readiness = read("server/services/launch-readiness-full.ts");
const registryBlock = readiness.slice(readiness.indexOf("PROBE_REGISTRY"), readiness.indexOf("export function settleProbe"));
const registryIds = [...registryBlock.matchAll(/\{ id: "([a-z_]+)", name: "[^"]+", run: (check[A-Za-z]+) \}/g)];
const probeFns = [...readiness.matchAll(/^async function (check[A-Za-z]+)\(/gm)].map(m => m[1]);
assert.equal(new Set(registryIds.map(m => m[1])).size, registryIds.length, "registry ids are unique");
assert.deepEqual(registryIds.map(m => m[2]).sort(), probeFns.sort(), "every probe function is in the registry and vice versa");
assert.ok(registryIds.length >= 26, "registry holds the live 26 probes");
assert.ok(!/\bsubsystemNames\b|const names\s*=\s*\[/.test(readiness), "no parallel name list");
for (const stale of ["deleted_at", "ghl_activity_logs", "document_type", "'manual_crm'", "outboundGlobalPaused", "status = 'open'"]) {
  assert.ok(!readiness.includes(stale), `readiness no longer references ${stale}`);
}
for (const required of ["account_state", "ghl_activity_log", "readTaskMetrics", "getPauseState", "authority_state", "inbound_requests", "evidenceQueryFailed"]) {
  assert.ok(readiness.includes(required), `readiness uses ${required}`);
}
const commsCatch = readiness.slice(readiness.indexOf("async function checkCommunicationsHub"), readiness.indexOf("async function checkSupportHub"));
assert.ok(/catch \(err[^)]*\) \{[\s\S]*configStatus === "fail" \? "fail" : "warn"/.test(commsCatch), "failed activity query is never a pass");
const page = read("client/src/pages/dashboard/LaunchReadiness.tsx");
assert.ok(!/25[- ]subsystem|All 25|25-Subsystem/i.test(page), "no fixed probe count in the readiness copy");

// ── R04: bounded audit reads and card labels ──
const audit = read("server/storage/audit.ts");
const byActions = audit.slice(audit.indexOf("async getAuditLogsByActions"), audit.indexOf("async getAuditLogsByEntity"));
assert.ok(byActions.includes("inArray(auditLogs.action") && byActions.indexOf("inArray(") < byActions.indexOf(".limit("), "action filter is applied in SQL before paging");
assert.ok(byActions.includes("count(*)") && byActions.includes("desc(auditLogs.id)"), "exact total and stable tie-break order");
const integrations = read("server/routes/integrations.ts");
const circuit = integrations.slice(integrations.indexOf('"/api/ghl/circuit-status"'), integrations.indexOf('"/api/ghl/email-config"'));
const deleted = integrations.slice(integrations.indexOf('"/api/ghl/deleted-records"'));
assert.ok(circuit.includes("getAuditLogsByActions") && !circuit.includes("storage.getAuditLogs()"), "circuit trip/reset read filters before paging");
assert.ok(deleted.includes("getAuditLogsByActions") && !deleted.includes("storage.getAuditLogs()") && deleted.includes('coverage: "exact"'), "deleted-records reads the matching family in SQL with exact coverage");
const operator = read("client/src/pages/dashboard/OperatorDashboard.tsx");
assert.ok(!operator.includes("All GHL operations are succeeding"), "no universal-success claim");
assert.ok(!/value=\{circuit\.isError \? "Error" : circuitOpen \? "Circuit OPEN" : "Connected"\}/.test(operator), "the circuit tile does not claim Connected");
assert.ok(operator.includes("jobFreshness"), "job health derives freshness from update time");

// ── R05: guidance and activation diagnostic ──
for (const f of ["client/src/pages/dashboard/GhlSequenceGuide.tsx", "client/src/pages/dashboard/MarketingPlaybook.tsx", "client/src/pages/dashboard/GhlWorkflowManager.tsx"]) {
  const src = read(f);
  for (const stale of ["All execution happens natively in GHL", "GHL owns 100% of execution", "Six automated GHL workflows", "GHL Execution Not Wired", "GHL runs ALL execution"]) {
    assert.ok(!src.includes(stale), `${f} no longer says "${stale}"`);
  }
}
assert.ok(read("client/src/pages/dashboard/GhlSequenceGuide.tsx").includes("GhlOwnershipNotice"));
assert.ok(read("client/src/pages/dashboard/MarketingPlaybook.tsx").includes("GhlOwnershipNotice"));
const activation = read("server/routes/activation.ts");
assert.ok(!activation.includes("At least 5 GHL workflow IDs mapped"), "generic workflow-ID quota removed");
assert.ok(activation.includes('id: "ghl_workflows_mapped"') && /informational/.test(activation) && /skip that enrollment when missing/.test(activation), "row kept for DTO consumers, reclassified, handoff IDs not declared inert");
assert.match(GHL_OWNERSHIP_SUMMARY, /Replit owns/);
assert.match(GHL_OWNERSHIP_STATEMENT.workflowIds, /reference-only/);
assert.match(GHL_OWNERSHIP_STATEMENT.workflowIds, /enrollment is skipped/, "handoff workflow IDs are distinguished from sequence IDs");
assert.match(GHL_OWNERSHIP_STATEMENT.incoming, /independently/);
assert.match(GHL_OWNERSHIP_STATEMENT.pause, /global outbound pause/);

console.log("stage3 C5 diagnostics: all assertions passed");
