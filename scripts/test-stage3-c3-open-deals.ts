import assert from "node:assert/strict";
import {randomInt} from "node:crypto";
import {stage3BHttpFixture} from "./fixtures/stage3-b-http";

// C3 R6 on a guarded disposable database: ONE pinned deal population read by every surface that reports "open sales
// deals". Outreach Command (company-wide), the Dashboard KPI (viewer scope) and the Revenue leads worklist must agree
// on the open-stage definition; only the declared owner scope may differ, and the scope is named in the payload.
const h=await stage3BHttpFixture(async app=>{
  const module=await import("../server/routes/analytics");
  module.registerAnalyticsRoutes(app);
});
try {
  const {storage}=await import("../server/storage");
  const {readRevenueLeads}=await import("../server/services/revenue-read-authority");
  const {OPEN_SALES_LEAD_STAGES}=await import("../shared/schema");
  const agentEmail=h.email("agent"), otherOwner=`${h.prefix}-someone-else@example.test`;
  const before=await storage.getDealAggregateStats();
  const kpiBefore:Record<string,number>={};
  for(const role of ["admin","manager","agent"]) kpiBefore[role]=(await h.request(role,"GET","/api/kpi/summary")).body.pipeline.totalActive;

  const seed=async(label:string,stage:string,owner:string|null,opts:{pipeline?:string;recordClass?:string;archived?:boolean}={})=>{
    const contact=await h.pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,record_class,assigned_to)
      VALUES('Open','Deal',$1,$2,'production',$3) RETURNING id`,[`${h.prefix}-od-${label}@example.test`,`+1555${randomInt(1000000,9999999)}`,owner]);
    await h.pool.query(`INSERT INTO deals(name,contact_id,pipeline,stage,record_class,owner,archived_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [`${h.prefix}-od-${label}`,contact.rows[0].id,opts.pipeline??"sales",stage,opts.recordClass??"production",owner,opts.archived?new Date():null]);
  };
  // Open (counted): every canonical open stage appears at least once across owners.
  await seed("mine-new","New Lead",agentEmail);
  await seed("mine-proposal","Proposal Sent",agentEmail);
  await seed("other-nego","Negotiation / Follow-Up",otherOwner);
  await seed("other-verbal","Verbal Commit",otherOwner);
  await seed("unowned-enriched","Enriched",null);
  // Not open: closed, legacy/unrecognized stages, archived, non-production classes, other pipelines.
  await seed("mine-won","Closed Won",agentEmail);
  await seed("mine-lost","Closed Lost",agentEmail);
  await seed("mine-legacy-contacted","Contacted",agentEmail);
  await seed("mine-legacy-qualified","Qualified",agentEmail);
  await seed("mine-archived","New Lead",agentEmail,{archived:true});
  await seed("mine-test","New Lead",agentEmail,{recordClass:"test"});
  await seed("mine-demo","Proposal Sent",agentEmail,{recordClass:"demo"});
  await seed("mine-onboarding","New Lead",agentEmail,{pipeline:"onboarding"});
  for(const stage of OPEN_SALES_LEAD_STAGES) assert.ok(stage.length>0);

  const allOwnersOpen=5, agentOpen=3; // two mine + one unowned
  const command=(await storage.getDealAggregateStats()).openSalesProduction-before.openSalesProduction;
  assert.equal(command,allOwnersOpen,"Outreach Command: open production sales deals, all owners");
  for(const role of ["admin","manager"]) {
    const response=await h.request(role,"GET","/api/kpi/summary");
    assert.equal(response.status,200);
    assert.equal(response.body.pipeline.totalActive-kpiBefore[role],allOwnersOpen,`${role} Dashboard agrees with Command`);
    assert.equal(response.body.pipeline.totalActiveScope,"all_owners");
  }
  const agent=await h.request("agent","GET","/api/kpi/summary");
  assert.equal(agent.status,200);
  assert.equal(agent.body.pipeline.totalActive-kpiBefore.agent,agentOpen,"agent Dashboard: owned and unassigned open deals only");
  assert.equal(agent.body.pipeline.totalActiveScope,"owned_or_unassigned","the narrower scope is declared, not implied");
  // Worklist: contacts with an open production sales deal; one contact per deal here, so it equals the open-deal count.
  const leads=await readRevenueLeads({role:"admin",email:h.email("admin")},{limit:50,offset:0,search:`${h.prefix}-od-`});
  assert.equal(leads.total,allOwnersOpen,"Revenue leads worklist uses the same open definition");
  const agentLeads=await readRevenueLeads({role:"agent",email:agentEmail},{limit:50,offset:0,search:`${h.prefix}-od-`});
  assert.ok(agentLeads.total<=allOwnersOpen && agentLeads.total>=2,`agent worklist is a subset of the company-wide open population (${agentLeads.total})`);
  assert.equal(h.externalCalls(),0);
  console.log("STAGE3_C3_OPEN_DEALS_PASS");
} finally {
  await h.close();
}
