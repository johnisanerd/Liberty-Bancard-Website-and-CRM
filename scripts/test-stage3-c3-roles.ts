import assert from "node:assert/strict";
import {stage3BHttpFixture} from "./fixtures/stage3-b-http";

// C3 G03 role matrix on a guarded disposable database with real sessions/CSRF: aggregate reads and the
// privileged Canonical commands. Denied roles are checked on mutation routes only (never an effect);
// allowed roles are checked on reads only. Nothing is enrolled, released, sent or provider-run.
const h=await stage3BHttpFixture(async app=>{
  (await import("../server/routes/imports")).registerImportsRoutes(app);
  (await import("../server/routes/canonical-enrichment")).registerCanonicalEnrichmentRoutes(app);
});
const roles=["admin","manager","agent","merchant","affiliate","partner"] as const;
try {
  const dashboardAggregate=new Map<string,string[]>([
    ["/api/outreach/status",["admin","manager","agent"]],
    ["/api/canonical-enrichment/status",["admin","manager"]],
    ["/api/canonical-enrichment/backlog",["admin","manager"]],
    ["/api/canonical-enrichment/launch-inventory",["admin","manager"]],
    ["/api/canonical-enrichment/release",["admin","manager"]],
  ]);
  const unauth=await Promise.all([...dashboardAggregate.keys()].map(async path=>({path,status:(await h.originalFetch(`${h.base}${path}`)).status})));
  for(const row of unauth) assert.ok([401,403].includes(row.status),`unauthenticated ${row.path} refused (${row.status})`);
  for(const [path,allowed] of dashboardAggregate) for(const role of roles) {
    const res=await h.request(role,"GET",path);
    if(allowed.includes(role)) assert.ok(![401,403].includes(res.status),`${role} may read ${path} (got ${res.status}; 5xx is an explicit unavailable state, never a zero)`);
    else assert.equal(res.status,403,`${role} must be denied ${path}`);
    if(!allowed.includes(role)) assert.ok(!("totalContacts" in (res.body??{})) && !("contacts" in (res.body??{})),`${role} receives no aggregate body from ${path}`);
  }
  // A failed/unavailable aggregate is never serialized as zeros for an allowed role.
  const status=await h.request("agent","GET","/api/outreach/status");
  if(status.status>=500) assert.ok(!JSON.stringify(status.body).match(/"totalContacts":0/),"unavailable status is not zero");

  // Privileged commands: every non-admin is denied before any effect.
  const commands:[string,string][]=[["POST","/api/canonical-enrichment/release/preview"],["POST","/api/canonical-enrichment/release/execute"],
    ["POST","/api/canonical-enrichment/release/revoke"],["PUT","/api/canonical-enrichment/release/policy"],
    ["POST","/api/canonical-enrichment/backlog/process"],["POST","/api/canonical-enrichment/release/enrollments/1/resolve"]];
  const before=(await h.pool.query("SELECT count(*)::int n FROM audit_logs")).rows[0].n;
  for(const [method,path] of commands) for(const role of ["manager","agent","merchant","affiliate","partner"] as const)
    assert.equal((await h.request(role,method,path,{})).status,403,`${role} must be denied ${method} ${path}`);
  for(const [method,path] of commands) assert.equal((await h.originalFetch(`${h.base}${path}`,{method,headers:{"content-type":"application/json"},body:"{}"})).status>=400,true);
  assert.equal((await h.pool.query("SELECT count(*)::int n FROM audit_logs")).rows[0].n,before,"denied commands wrote nothing");
  assert.equal(h.externalCalls(),0);
  console.log("STAGE3_C3_ROLES_PASS");
} finally { await h.close(); }
