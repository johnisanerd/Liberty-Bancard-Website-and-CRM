import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {stage3BHttpFixture} from "./fixtures/stage3-b-http";

// C3 F03 acceptance on a guarded disposable database: when the audit write fails AFTER an effect committed,
// the route still returns the committed receipt (committed:true, audit:"failed"), never a "nothing happened"
// error, and the effect is durable on readback. A rejected command reports committed:false.
const h=await stage3BHttpFixture(async app=>{
  (await import("../server/routes/canonical-enrichment")).registerCanonicalEnrichmentRoutes(app);
});
const {storage}=await import("../server/storage");
const original=storage.createAuditLog.bind(storage);
let auditAttempts=0;
try {
  const policyRow=async()=>(await h.pool.query("SELECT value FROM system_settings WHERE key='sfp_canonical_release_policy'")).rows[0]?.value;
  // Control: with audit working the receipt says recorded.
  const ok=await h.request("admin","PUT","/api/canonical-enrichment/release/policy",{journeyDays:9});
  assert.equal(ok.status,200,JSON.stringify(ok.body));
  assert.equal(ok.body.committed,true);assert.equal(ok.body.audit,"recorded");

  // Inject an audit failure after the effect.
  (storage as any).createAuditLog=async()=>{auditAttempts++;throw new Error("injected audit failure");};
  const failed=await h.request("admin","PUT","/api/canonical-enrichment/release/policy",{journeyDays:11});
  assert.equal(failed.status,200,"a committed effect is not reported as an error");
  assert.equal(failed.body.committed,true);assert.equal(failed.body.audit,"failed");
  assert.equal(failed.body.policy.journeyDays,11);
  assert.equal((await policyRow()).journeyDays,11,"the effect is durable on readback");
  assert.ok(auditAttempts>=1,"the injected failure executed");

  const revoke=await h.request("admin","POST","/api/canonical-enrichment/release/revoke",{});
  assert.equal(revoke.status,200);assert.equal(revoke.body.committed,true);assert.equal(revoke.body.audit,"failed");
  assert.equal(revoke.body.revoked,false,"nothing was live to revoke; the receipt says so");

  // A rejected command is never reported committed (and the audit is not the thing deciding that).
  const rejected=await h.request("admin","PUT","/api/canonical-enrichment/release/policy",{journeyDays:1});
  assert.equal(rejected.status,400);assert.notEqual(rejected.body.committed,true);
  assert.equal((await policyRow()).journeyDays,11,"rejected input changed nothing");
  const resolve=await h.request("admin","POST",`/api/canonical-enrichment/release/enrollments/${2_000_000_000}/resolve`,{resolution:"clear_hold"});
  assert.notEqual(resolve.body.committed,true,"an unresolved hold is not reported committed");

  // Backlog process: no queue manager is initialised in this fixture (starting the worker fleet is out of bounds), so the
  // route reports truthfully that nothing was queued. A failing audit write must not change that outcome or hide the result.
  const process1=await h.request("admin","POST","/api/canonical-enrichment/backlog/process",{scope:"local_only",maxRows:500,timeBudgetSeconds:120,commandId:randomUUID()});
  assert.equal(process1.status,503,"an unavailable queue is not reported as accepted");
  assert.equal(process1.body.accepted,false);assert.ok(/nothing was queued/i.test(process1.body.message));
  assert.ok(process1.body.audit==="failed"||process1.body.audit==="recorded");
  const process2=await h.request("admin","POST","/api/canonical-enrichment/backlog/process",{scope:"local_only",maxRows:500,timeBudgetSeconds:120,commandId:randomUUID()});
  assert.equal(process2.body.audit,"failed","the injected audit failure is reported beside the real result");
  assert.equal(process2.body.accepted,false,"audit failure does not turn a not-queued request into accepted");
  const badProcess=await h.request("admin","POST","/api/canonical-enrichment/backlog/process",{scope:"local_only",maxRows:-5});
  assert.equal(badProcess.status,400,"an invalid limit is rejected, not replaced");
  for(const role of ["manager","agent","merchant","partner"]) assert.equal((await h.request(role,"POST","/api/canonical-enrichment/backlog/process",{})).status,403,`${role} cannot request a backlog pass`);

  // Replay of the same release intent reuses its identity: preview never creates a release.
  assert.equal((await h.pool.query("SELECT count(*)::int n FROM system_settings WHERE key='sfp_canonical_release_control'")).rows[0].n,0);
  assert.equal(h.externalCalls(),0);
  console.log("STAGE3_C3_POST_COMMIT_PASS");
} finally { (storage as any).createAuditLog=original; await h.close(); }
