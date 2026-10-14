import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import {mkdir,writeFile,readFile} from "node:fs/promises";
import {stage3BHttpFixture} from "./fixtures/stage3-b-http";
import {verifyCandidateIdentity} from "./fixtures/candidate-build-identity";
import {operationsReportSchema} from "../shared/operations-report";
import {npsStatsReadSchema,npsRecordsReadSchema} from "../shared/nps-observation";
import {workDueDay,workDueDateChange} from "../client/src/lib/work-due-date";

// The fixture proves isolation before importing DB-dependent application code.
const identity=await verifyCandidateIdentity();
const rows:Array<Record<string,unknown>>=[];
let preparationFault:string|undefined;
const preparationFaults:Array<{step:string;executed:true}>=[];
let leaderboardReadFault:string|undefined;
const leaderboardFaults:Array<string>=[];
const h=await stage3BHttpFixture(async app=>{
  for(const [file,fn] of [
    ["contacts","registerContactsRoutes"],["deals","registerDealsRoutes"],
    ["chargebacks","registerChargebacksRoutes"],["portfolio","registerPortfolioRoutes"],
    ["routes-revenue","registerRevenueRoutes"],["crm-operations","registerCrmOperationsRoutes"],
    ["tickets-tasks","registerTicketsTasksRoutes"],["my-day","registerMyDayRoutes"],
    ["activity","registerActivityRoutes"],
    ["analytics","registerAnalyticsRoutes"],
    ["residuals","registerResidualsRoutes"],
    ["review-queue","registerReviewQueueRoutes"],
    ["boarding","registerBoardingRoutes"],["documents","registerDocumentsRoutes"],
    ["statement-review","registerStatementReviewRoutes"],
    ["testimonials","registerTestimonialRoutes"],
    ["workflows","registerWorkflowsRoutes"],
    ["churn","registerChurnRoutes"],
    ["campaigns","registerCampaignsRoutes"],
    ["acquisition","registerAcquisitionRoutes"],
    ["lifecycle","registerLifecycleRoutes"],
  ]) {const module=await import(`../server/routes/${file}.ts`);module[fn](app,file==="analytics"?{
    leaderboardQuery:async(source:string,query:string)=>{
      if(source===leaderboardReadFault){leaderboardFaults.push(source);throw new Error("Owned leaderboard source fault");}
      const {pool}=await import("../server/db");return pool.query(query);
    },
  }:file==="crm-operations" ? {
    onboardingPreparationAfterStep:async(step:string)=>{
      if(step===preparationFault){preparationFault=undefined;preparationFaults.push({step,executed:true});throw new Error("Owned post-step fault");}
    },
  }:undefined);}
  const {registerInboxRoutes}=await import("../server/routes/inbox");
  registerInboxRoutes(app,{config:()=>null,read:async()=>{throw new Error("Provider readers denied in C4 local-source fixture");}});
},undefined,{backgroundProfile:"off"});
async function check(role:string,method:string,path:string,body:unknown,status:number,note:string,headers:Record<string,string>={}) {
  const result=await h.request(role as any,method,path,body,true,headers);
  assert.equal(result.status,status,`${note}: ${JSON.stringify(result.body)}`);
  rows.push({role,method,path,status,note});
  return result.body;
}
try {
  const emptyAb = await check("admin","GET","/api/sequences/ab-test-results",undefined,200,"literal A/B reader and genuine empty results");
  assert.deepEqual(emptyAb,[]);
  await check("manager","GET","/api/sequences/ab-test-results",undefined,200,"manager A/B reader");
  for(const role of ["agent","merchant","partner"])
    await check(role,"GET","/api/sequences/ab-test-results",undefined,403,`${role} A/B denial`);
  await check("anonymous","GET","/api/sequences/ab-test-results",undefined,401,"anonymous A/B denial");
  const {followUpSequences,sequenceSteps}=await import("../shared/schema");
  const sequenceFixtures=await h.db.insert(followUpSequences).values([
    {name:`${h.prefix} manager A/B`,createdBy:h.userId("manager"),status:"paused"},
    {name:`${h.prefix} foreign A/B`,createdBy:h.userId("other"),status:"paused"},
  ]).returning();
  await h.db.insert(sequenceSteps).values(sequenceFixtures.map(sequence=>({
    sequenceId:sequence.id,stepOrder:1,actionType:"email",subject:"A",body:"A body",
    variantBSubject:"B",variantBBody:"B body",abTestConfig:{splitRatio:50,minSampleSize:100,winnerCriteria:"open_rate"},
    abTestResults:{variantASent:3,variantBSent:4,aOpens:1,bOpens:2,aClicks:0,bClicks:1,aReplies:0,bReplies:0},
  })));
  const populatedAb=await check("admin","GET","/api/sequences/ab-test-results",undefined,200,"real populated A/B aggregation");
  assert.deepEqual(populatedAb.map((row:any)=>row.sequenceId).sort((a:number,b:number)=>a-b),sequenceFixtures.map(sequence=>sequence.id).sort((a,b)=>a-b));
  assert.equal(populatedAb[0].abTestResults.variantASent,3);assert.equal(populatedAb[0].abTestResults.variantBSent,4);
  const ownedAb=await check("manager","GET","/api/sequences/ab-test-results",undefined,200,"manager excludes foreign sequence results");
  assert.deepEqual(ownedAb.map((row:any)=>row.sequenceId),[sequenceFixtures[0].id]);
  await check("admin","GET",`/api/sequences/${sequenceFixtures[1].id}`,undefined,200,"numeric sequence route survives literal repair");
  await check("manager","GET",`/api/sequences/${sequenceFixtures[0].id}`,undefined,200,"manager numeric owned sequence read");
  await check("manager","GET",`/api/sequences/${sequenceFixtures[1].id}`,undefined,403,"manager numeric foreign sequence denial");
  assert.equal(h.externalCalls(),0,"A/B reads never activate sequences or dispatch providers");
  const {calendarEvents}=await import("../shared/schema");
  for(const [zone,start,end] of [
    ["UTC","2026-10-01T00:00:00Z","2026-11-01T00:00:00Z"],
    ["America/New_York","2026-10-01T00:00:00-04:00","2026-11-01T00:00:00-04:00"],
    ["America/Los_Angeles","2026-10-01T00:00:00-07:00","2026-11-01T00:00:00-07:00"],
  ]) {
    const upper=new Date(end),lower=new Date(start);
    const created=await h.db.insert(calendarEvents).values([
      {title:`C4 last instant ${zone}`,startTime:new Date(upper.getTime()-1),endTime:upper,ownerId:h.userId("agent")},
      {title:`C4 excluded upper ${zone}`,startTime:upper,endTime:new Date(upper.getTime()+60000),ownerId:h.userId("agent")},
      {title:`C4 spanning lower ${zone}`,startTime:new Date(lower.getTime()-60000),endTime:new Date(lower.getTime()+60000),ownerId:h.userId("agent")},
      {title:`C4 foreign ${zone}`,startTime:new Date(upper.getTime()-1000),endTime:upper,ownerId:h.userId("other")},
    ]).returning();
    const window=new URLSearchParams({start,end});
    for(const role of ["admin","agent"]){
      const data=await check(role,"GET",`/api/calendar-events?${window}`,undefined,200,`real Calendar exclusive month boundary, ${zone}, ${role}`);
      const ids=data.map((r:any)=>r.id);
      assert.ok(ids.includes(created[0].id));assert.ok(ids.includes(created[2].id));
      assert.ok(!ids.includes(created[1].id));
      assert.equal(ids.includes(created[3].id),role==="admin","agent ownership preserved");
    }
  }
  for(const bad of ["start=invalid&end=2026-11-01","start=2026-11-01&end=2026-10-01","start=2026-10-01","start=2026-10-01&start=2026-09-01&end=2026-11-01"])
    await check("admin","GET",`/api/calendar-events?${bad}`,undefined,400,`invalid Calendar window: ${bad}`);
  const {contacts,merchantMids,chargebacks,merchantResiduals,deals,documents,statementReviews}=await import("../shared/schema");
  const contact=(await h.db.insert(contacts).values({firstName:h.prefix,lastName:"C4-owned",email:`${h.prefix}-merchant@example.test`,
    phone:"",assignedTo:h.email("agent"),recordClass:"production"}).returning())[0];
  const foreign=(await h.db.insert(contacts).values({firstName:h.prefix,lastName:"C4-foreign",
    email:`${h.prefix}-foreign@example.test`,phone:"",assignedTo:h.email("other"),recordClass:"production"}).returning())[0];
  const mid=(await h.db.insert(merchantMids).values({contactId:contact.id,mid:`${h.prefix}-mid`,
    status:"active",activatedAt:new Date()}).returning())[0];
  const deal=(await h.db.insert(deals).values({contactId:contact.id,pipeline:"sales",stage:"Statement Received",
    owner:h.email("agent"),recordClass:"production"}).returning())[0];
  const transitions=await check("agent","GET",`/api/deals/${deal.id}/transition-options`,undefined,200,"exact existing transition policy observation");
  assert.equal(transitions.capability,"structural_policy_observation_only");
  assert.ok(!transitions.stages.includes("New Lead"));
  assert.ok(transitions.stages.includes("Proposal Sent"));
  await check("other","GET",`/api/deals/${deal.id}/transition-options`,undefined,404,"foreign transition policy denied");
  const {auditLogs,tasks,onboardingChecklistItems,users}=await import("../shared/schema");
  const {CLOSED_WON_SLA_TASKS}=await import("../server/services/deal-stage-service");
  const {eq,and,sql}=await import("drizzle-orm");
  const [principal]=await h.db.select().from(users).where(eq(users.id,h.userId("agent")));
  const won=async()=> (await h.db.insert(deals).values({contactId:contact.id,pipeline:"sales",stage:"Closed Won",
    owner:h.email("agent"),recordClass:"production",updatedAt:new Date("2026-10-01T13:14:15.000Z")}).returning())[0];
  const fields=async(id:number)=>{
    const descriptor=await check("agent","GET",`/api/deals/${id}/onboarding-preparation`,undefined,200,"exact lossless linked preparation descriptor");
    return {contactId:contact.id,expectedSourceVersion:descriptor.expectedSourceVersion,expectedActorId:h.userId("agent"),
      expectedAccountVersion:principal.accountVersion,terminalNeeded:"yes",goLiveDate:"2026-11-15",fundingNotes:"Owned planning fixture",underwritingDocs:[]};
  };
  await check("agent","GET",`/api/deals/${deal.id}/onboarding-preparation`,undefined,409,"non-Closed-Won admission refused");
  const source=await won(),body=await fields(source.id),preparePath=`/api/deals/${source.id}/onboarding-preparation`,prepareKey=randomUUID();
  const unaccepted=await check("agent","GET",`${preparePath}?commandId=${prepareKey}`,undefined,200,"authorized exact absent intent, not a denied object");
  assert.equal(unaccepted.accepted,false);assert.equal(unaccepted.command,null);
  await check("other","GET",preparePath,undefined,404,"foreign source preparation denied");
  await check("agent","POST",preparePath,body,400,"missing preparation idempotency key");
  await check("agent","POST",preparePath,{...body,goLiveDate:"2026-02-30"},400,"invalid planning date",{"Idempotency-Key":prepareKey});
  await check("agent","POST",preparePath,{...body,expectedActorId:h.userId("manager")},409,"captured actor changed",{"Idempotency-Key":prepareKey});
  await check("agent","POST",preparePath,{...body,expectedSourceVersion:"stale"},409,"lossless source version changed",{"Idempotency-Key":prepareKey});
  const prepared=await check("agent","POST",preparePath,body,202,"linked local preparation acceptance",{"Idempotency-Key":prepareKey});
  assert.equal(prepared.command.state,"prepared");assert.equal(prepared.command.nativeOutcome,"not_requested");
  assert.equal(prepared.command.steps.length,6);
  const linkedId=prepared.command.onboardingDealId;
  assert.equal((await h.db.select().from(deals).where(eq(deals.id,source.id)))[0].pipeline,"sales");
  const [firstTask]=await h.db.select().from(tasks).where(eq(tasks.dealId,linkedId));
  // Historical completed fixture; replay must not reopen or replace it.
  await h.db.update(tasks).set({status:"completed",authorityState:"completed",completedAt:new Date("2026-10-02T12:00:00Z")}).where(eq(tasks.id,firstTask.id));
  const beforeTasks=await h.db.select().from(tasks).where(eq(tasks.dealId,linkedId));
  assert.equal(beforeTasks.length,5);
  const beforeChecklist=await h.db.select().from(onboardingChecklistItems).where(eq(onboardingChecklistItems.dealId,linkedId));
  const preparationReplay=await check("agent","POST",preparePath,body,202,"unchanged preparation replay",{"Idempotency-Key":prepareKey});
  assert.deepEqual(preparationReplay.command,prepared.command);
  const uppercase=await check("agent","POST",preparePath,body,202,"UUID casing reuses the same intent",{"Idempotency-Key":prepareKey.toUpperCase()});
  assert.equal(uppercase.command.commandId,prepareKey);
  await check("agent","POST",preparePath,{...body,fundingNotes:"changed"},409,"changed preparation payload refused",{"Idempotency-Key":prepareKey});
  const duplicate=await Promise.all([h.request("agent","POST",preparePath,body,true,{"Idempotency-Key":prepareKey}),
    h.request("agent","POST",preparePath,body,true,{"Idempotency-Key":prepareKey})]);
  assert.deepEqual(duplicate.map(r=>r.status),[202,202]);
  assert.equal((await h.db.select().from(auditLogs).where(and(eq(auditLogs.entityKey,`onboarding-local-prepare:${prepareKey}`),
    eq(auditLogs.action,"onboarding_local_prepare_accepted")))).length,1);
  assert.deepEqual(await h.db.select().from(tasks).where(eq(tasks.dealId,linkedId)),beforeTasks);
  assert.deepEqual(await h.db.select().from(onboardingChecklistItems).where(eq(onboardingChecklistItems.dealId,linkedId)),beforeChecklist);
  await h.db.update(deals).set({owner:h.email("other")}).where(eq(deals.id,linkedId));
  await check("agent","GET",preparePath,undefined,404,"descriptor cannot expose reassigned linked command");
  await check("agent","GET",`${preparePath}?commandId=${prepareKey}`,undefined,404,"retained command rechecks target ownership");
  await h.db.update(deals).set({owner:h.email("agent")}).where(eq(deals.id,linkedId));
  await h.db.update(deals).set({archivedAt:new Date()}).where(eq(deals.id,linkedId));
  await check("agent","POST",preparePath,body,404,"archived target replay denied without replacement",{"Idempotency-Key":prepareKey});
  assert.equal((await h.db.select().from(deals).where(eq(deals.salesDealId,source.id))).length,1);
  await h.db.update(deals).set({archivedAt:null}).where(eq(deals.id,linkedId));
  for(const step of ["deal","checklist",...CLOSED_WON_SLA_TASKS.map(s=>s.title)]){
    const interrupted=await won(),input=await fields(interrupted.id),id=randomUUID();
    const path=`/api/deals/${interrupted.id}/onboarding-preparation`;
    preparationFault=step;
    await check("agent","POST",path,input,503,`executed accepted-step fault: ${step}`,{"Idempotency-Key":id});
    assert.equal(preparationFaults.at(-1)?.step,step);
    const read=await check("agent","GET",`${path}?commandId=${id}`,undefined,200,`durable accepted-step readback: ${step}`);
    const retainedTaskIds=read.command.steps.filter((s:any)=>s.taskId).map((s:any)=>s.taskId);
    const resumed=await check("agent","POST",`${path}/${id}/resume`,
      {expectedActorId:h.userId("agent"),expectedAccountVersion:principal.accountVersion},202,
      `retry only unfinished local preparation: ${step}`,{"Idempotency-Key":id});
    assert.equal(resumed.command.state,"prepared");
    assert.equal(resumed.command.onboardingDealId,read.command.onboardingDealId);
    assert.ok(retainedTaskIds.every((taskId:number)=>resumed.command.steps.some((s:any)=>s.taskId===taskId)));
    assert.equal((await h.db.select().from(tasks).where(eq(tasks.dealId,resumed.command.onboardingDealId))).length,5);
  }
  const cb=(await h.db.insert(chargebacks).values({contactId:contact.id,transactionDate:new Date(),amount:42,
    cardBrand:"Visa",reasonCode:"10.4",status:"New"}).returning())[0];
  const cbForeign=(await h.db.insert(chargebacks).values({contactId:foreign.id,transactionDate:new Date(),
    amount:9,cardBrand:"Visa",reasonCode:"10.4",status:"New"}).returning())[0];
  const path=`/api/chargebacks/${cb.id}/submit-to-card-brand`;
  const key=randomUUID(),headers={"Idempotency-Key":key},payload={midId:mid.id,evidenceNotes:"safe disposable evidence"};
  await check("agent","POST",path,payload,400,"UUIDv4 missing");
  await check("agent","POST",path,payload,400,"UUID invalid",{"Idempotency-Key":"invalid"});
  await check("agent","POST",path,{},400,"MID omitted",headers);
  await check("agent","POST",path,{midId:999999},409,"MID not related",headers);
  await check("other","POST",path,payload,404,"foreign-owned target denied before acceptance",headers);
  await check("agent","GET",`/api/chargebacks/${cbForeign.id}/submission-commands`,undefined,404,"foreign ledger denied");
  for(const role of ["merchant","partner","affiliate"])
    await check(role,"GET",`/api/chargebacks/${cb.id}/submission-mids`,undefined,403,"portal roles denied");
  const options=await check("agent","GET",`/api/chargebacks/${cb.id}/submission-mids`,undefined,200,"authorized masked exact MID");
  assert.equal(options.data[0].id,mid.id);
  assert.ok(!JSON.stringify(options).includes(mid.mid));
  const accepted=await check("agent","POST",path,payload,202,"durable acceptance only",headers);
  assert.equal(accepted.accepted,true);assert.equal(accepted.command.state,"pending");
  const replay=await check("agent","POST",path,payload,202,"same-key unchanged replay",headers);
  assert.equal(replay.command.id,accepted.command.id);
  const clicks=await Promise.all([h.request("agent","POST",path,payload,true,headers),h.request("agent","POST",path,payload,true,headers)]);
  assert.ok(clicks.every(result=>result.status===202 && result.body.command.id===accepted.command.id));
  rows.push({note:"concurrent double-click",count:2,sameCommand:true});
  await check("agent","POST",path,{...payload,evidenceNotes:"changed"},409,"same key changed payload conflicts",headers);
  const faultKey=randomUUID();
  h.loseNextSuccessfulResponse("POST",path,"truncate");
  await assert.rejects(h.request("agent","POST",path,payload,true,{"Idempotency-Key":faultKey}));
  assert.equal(h.responseLossCount(),1);
  assert.ok(h.responseFaultEvents.some(event=>event.event==="executed"));
  const recovered=await check("agent","POST",path,payload,202,"post-commit response loss unchanged retry",{"Idempotency-Key":faultKey});
  const lostSource=await won(),lostBody=await fields(lostSource.id),lostKey=randomUUID();
  const lostPath=`/api/deals/${lostSource.id}/onboarding-preparation`;
  h.loseNextSuccessfulResponse("POST",lostPath,"truncate");
  await assert.rejects(h.request("agent","POST",lostPath,lostBody,true,{"Idempotency-Key":lostKey}));
  assert.equal(h.responseLossCount(),2,"Actual preparation response fault executed after commit");
  const lostRead=await check("agent","GET",`${lostPath}?commandId=${lostKey}`,undefined,200,"post-commit preparation response-loss readback");
  const lostRetry=await check("agent","POST",lostPath,lostBody,202,"post-commit preparation unchanged retry",{"Idempotency-Key":lostKey});
  assert.deepEqual(lostRetry.command,lostRead.command);
  const ledger=await check("agent","GET",`/api/chargebacks/${cb.id}/submission-commands`,undefined,200,"accepted intents persist/read back");
  assert.equal(ledger.chargebackId,cb.id);
  assert.equal(ledger.hasPriorIntent,true);
  assert.equal(ledger.intentExistenceCompleteness,"all_case_commands");
  assert.equal(ledger.data.length,2);
  assert.equal(new Set(ledger.data.map((command:any)=>command.id)).size,2);
  assert.ok(!JSON.stringify(ledger).includes(mid.mid));
  assert.equal((await h.pool.query("SELECT status FROM chargebacks WHERE id=$1",[cb.id])).rows[0].status,"New");
  // These are simulated ledger observations, NOT worker/native execution.
  for(const state of ["processing","retryable","reconcile_required","terminal_failed","succeeded"]) {
    await h.pool.query("UPDATE chargeback_submission_commands SET state=$1 WHERE id=$2",[state,recovered.command.id]);
    const observed=await check("agent","GET",`/api/chargebacks/${cb.id}/submission-commands`,undefined,200,`simulated delayed ${state} read`);
    assert.equal(observed.data.find((command:any)=>command.id===recovered.command.id).state,state);
  }
  const {calendarEvents:boundaryEvents}=await import("../shared/schema");
  for(const [start,end] of [
    ["2026-10-01T05:00:00Z","2026-11-01T05:00:00Z"],
    ["2026-10-01T00:00:00Z","2026-11-01T00:00:00Z"],
    ["2026-09-30T10:00:00Z","2026-10-31T10:00:00Z"],
    ["2026-10-01T04:00:00Z","2026-11-01T05:00:00Z"],
  ]) {
    const first=Date.parse(start),exclusiveEnd=Date.parse(end);
    const [last,boundary,closed,foreign]=await h.db.insert(boundaryEvents).values([
      {title:`${h.prefix} last local day`,startTime:new Date(exclusiveEnd-3600000),endTime:new Date(exclusiveEnd-1800000),ownerId:h.userId("agent")},
      {title:`${h.prefix} next month boundary`,startTime:new Date(exclusiveEnd),endTime:new Date(exclusiveEnd+3600000),ownerId:h.userId("agent")},
      {title:`${h.prefix} previous closed`,startTime:new Date(first-7200000),endTime:new Date(first-3600000),ownerId:h.userId("agent")},
      {title:`${h.prefix} other owner last day`,startTime:new Date(exclusiveEnd-3600000),endTime:new Date(exclusiveEnd-1800000),ownerId:h.userId("other")},
    ]).returning();
    const url=`/api/calendar-events?${new URLSearchParams({start,end})}`;
    for (const role of ["agent","manager"]) {
      const events=await check(role,"GET",url,undefined,200,`authorized Calendar half-open window ${start}/${end}`);
      const ids=events.map((event:any)=>event.id);
      assert.ok(ids.includes(last.id),"Last local day is retained");
      assert.ok(!ids.includes(boundary.id),"Exact next-month start is excluded");
      assert.ok(!ids.includes(closed.id),"Previous closed event is excluded");
      assert.equal(ids.includes(foreign.id),role==="manager","Agent ownership remains independent of window filtering");
    }
  }
  for(const role of ["merchant","partner"])
    await check(role,"GET","/api/calendar-events?start=2026-10-01T05%3A00%3A00Z&end=2026-11-01T05%3A00%3A00Z",undefined,403,
      "Portal role denied employee Calendar reader");
  const before=(await h.pool.query("SELECT count(*)::int n FROM chargeback_submission_commands WHERE chargeback_id=$1",[cb.id])).rows[0].n;
  await h.pool.query("UPDATE merchant_mids SET status='closed' WHERE id=$1",[mid.id]);
  await check("agent","POST",path,payload,409,"stale MID new intent denied",{"Idempotency-Key":randomUUID()});
  assert.equal((await h.pool.query("SELECT count(*)::int n FROM chargeback_submission_commands WHERE chargeback_id=$1",[cb.id])).rows[0].n,before);
  await check("agent","GET","/api/revenue/residual-group-scope",undefined,403,"privileged financial wrapper retained");
  await check("admin","GET","/api/revenue/residual-group-scope?parentId=999999",undefined,404,"missing parent exact read denied");
  const parent=(await h.db.insert(contacts).values({firstName:h.prefix,lastName:"Group",
    email:`${h.prefix}-parent@example.test`,phone:"",recordClass:"production",isParentAccount:true}).returning())[0];
  const children=await h.pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,parent_contact_id,record_class)
    SELECT $1,'Group member '||n,$1||'-group-'||n||'@example.test','',$2,'production'
    FROM generate_series(1,501) n RETURNING id`,[h.prefix,parent.id]);
  const groupMid=(await h.db.insert(merchantMids).values({contactId:children.rows.at(-1).id,mid:`${h.prefix}-group-mid`,
    status:"active",activatedAt:new Date()}).returning())[0];
  const residual=(await h.db.insert(merchantResiduals).values({contactId:children.rows.at(-1).id,
    merchantMid:groupMid.mid,month:"2026-10",revenue:"100"}).returning())[0];
  const group=await check("admin","GET",`/api/revenue/residual-group-scope?parentId=${parent.id}`,undefined,200,"uncapped exact financial relationship and MID observation IDs");
  const projected=group.observations.find((row:any)=>row.id===residual.id);
  assert.equal(projected.registeredMidId,groupMid.id);
  assert.equal(projected.registeredMidContactId,children.rows.at(-1).id);
  assert.equal(projected.observationContactId,children.rows.at(-1).id);
  assert.equal(projected.revenue,100);
  assert.equal(group.observationSummary.cost,null);
  assert.equal(group.observationSummary.nativeExecution,"unverified");
  assert.match(group.snapshotIdentity,/^[a-f0-9]{64}$/);
  const selectedPeriod=await check("admin","GET",`/api/revenue/residual-group-scope?parentId=${parent.id}&period=2026-10`,undefined,200,"financial registered period shares row and summary scope");
  assert.deepEqual(selectedPeriod.observations.map((r:any)=>r.id),[residual.id]);
  assert.equal(selectedPeriod.observationSeries[0].totalRevenue,100);
  const noPeriod=await check("admin","GET",`/api/revenue/residual-group-scope?parentId=${parent.id}&period=2026-09`,undefined,200,"known empty captured period has unavailable monetary total not zero");
  assert.equal(noPeriod.observationSummary.revenue,null);
  assert.deepEqual(noPeriod.observations,[]);
  assert.deepEqual(noPeriod.observationPayees,[]);
  const {agents:agentTable}=await import("../shared/schema");
  const capturedAgents=await h.db.insert(agentTable).values([1,2].map(n=>({
    firstName:h.prefix,lastName:"Same captured label",email:`${h.prefix}-payee-${n}@example.test`,
  }))).returning();
  await h.db.update(merchantResiduals).set({agentId:capturedAgents[0].id,agentCommission:"0.30"}).where(eq(merchantResiduals.id,residual.id));
  await h.db.insert(merchantResiduals).values({
    contactId:children.rows.at(-1).id,merchantMid:groupMid.mid,month:"2026-10",
    agentId:capturedAgents[1].id,revenue:"0.20",agentCommission:null,
  });
  const payees=await check("manager","GET",`/api/revenue/residual-group-scope?parentId=${parent.id}&period=2026-10`,undefined,200,
    "same-snapshot typed agent attribution keeps equal labels separate and missing money unavailable");
  assert.deepEqual(payees.observationPayees.map((r:any)=>r.agentId),capturedAgents.map(a=>a.id));
  assert.equal(payees.observationPayees[0].agentCommission,0.3);
  assert.equal(payees.observationPayees[1].agentCommission,null);
  assert.equal(payees.observationPayees[0].agentLabel,payees.observationPayees[1].agentLabel);
  assert.equal(payees.observationSummary.revenue,100.2);
  const emptyPayees=await check("admin","GET",`/api/revenue/residual-group-scope?parentId=${parent.id}&period=2026-09`,undefined,200,
    "empty recorded period does not substitute agent roster totals");
  assert.deepEqual(emptyPayees.observationPayees,[]);
  const {partnerOrganizations,residualImports}=await import("../shared/schema");
  const partnerOrgs=await h.db.insert(partnerOrganizations).values([1,2].map(n=>({
    name:"Same captured partner label",slug:`${h.prefix}-partner-${n}`,
  }))).returning();
  const [confirmedImport,pendingImport]=await h.db.insert(residualImports).values([
    {month:"2026-10",fileName:"Owned confirmed record",status:"confirmed"},
    {month:"2026-10",fileName:"Owned pending record",status:"pending"},
  ]).returning();
  const partnerDeals=await h.db.insert(deals).values([0,1,2].map(n=>({
    title:`${h.prefix} partner observation ${n}`,contactId:children.rows.at(-1).id,
    owner:h.email("agent"),pipeline:"Sales",stage:"Closed Won",recordClass:"production",partnerOrgId:partnerOrgs[n===1?1:0].id,
    archivedAt:n===2?new Date():null,
  }))).returning();
  await h.db.insert(merchantResiduals).values([
    {contactId:children.rows.at(-1).id,merchantMid:groupMid.mid,merchantName:"C4 partner one",month:"2026-10",importId:confirmedImport.id,dealId:partnerDeals[0].id,revenue:"10.10",netRevenue:null,partnerCommission:"0.10"},
    {contactId:children.rows.at(-1).id,merchantMid:groupMid.mid,merchantName:"C4 partner two",month:"2026-10",importId:confirmedImport.id,dealId:partnerDeals[1].id,revenue:"0",netRevenue:"0",partnerCommission:null},
    {contactId:children.rows.at(-1).id,merchantMid:groupMid.mid,month:"2026-10",importId:confirmedImport.id,dealId:partnerDeals[2].id,revenue:"0.20"},
    {contactId:children.rows.at(-1).id,merchantMid:groupMid.mid,month:"2026-10",importId:confirmedImport.id,revenue:"0.30"},
    {contactId:children.rows.at(-1).id,merchantMid:groupMid.mid,month:"2026-10",importId:pendingImport.id,dealId:partnerDeals[0].id,revenue:"0.40"},
  ]);
  for(const role of ["admin","manager"]) {
    const read=await check(role,"GET",`/api/revenue/residual-group-scope?parentId=${parent.id}&period=2026-10`,undefined,200,
      "confirmed partner subset shares exact financial parent/period snapshot");
    const partners=read.observationPartners;
    assert.deepEqual(partners.rows.map((r:any)=>r.orgId),partnerOrgs.map(r=>r.id));
    assert.equal(partners.rows[0].totalGrossResidual,10.10);
    assert.equal(partners.rows[0].totalNetResidual,null);
    assert.equal(partners.rows[1].totalGrossResidual,0);
    assert.equal(partners.rows[1].totalPartnerCommission,null);
    assert.equal(partners.confirmedObservationCount,4);
    assert.equal(partners.unavailableRelationshipCount,2,"archived/missing captured deal is not no assignment");
    assert.equal(partners.unconfirmedOrUnlinkedImportCount,3);
  }
  const searchedPartners=await check("manager","GET",`/api/revenue/residual-group-scope?parentId=${parent.id}&period=2026-10&search=C4%20partner%20two`,undefined,200,
    "partner presentation uses the worklist's exact search population");
  assert.equal(searchedPartners.observations.length,1);
  assert.deepEqual(searchedPartners.observationPartners.rows.map((r:any)=>r.orgId),[partnerOrgs[1].id]);
  const noPartnerPeriod=await check("manager","GET",`/api/revenue/residual-group-scope?parentId=${parent.id}&period=2026-09`,undefined,200,"empty exact partner period is not zero earnings");
  assert.deepEqual(noPartnerPeriod.observationPartners.rows,[]);
  const legacyPartners=await check("manager","GET","/api/residuals/by-partner",undefined,200,
    "compatibility entrance delegates canonical confirmed-observation projection");
  const legacyFirst=legacyPartners.find((r:any)=>r.orgId===partnerOrgs[0].id);
  assert.equal(legacyFirst.totalGrossResidual,"10.1");
  assert.equal(legacyFirst.totalNetResidual,null);
  for(const role of ["agent","other","merchant","partner"])
    await check(role,"GET","/api/residuals/by-partner",undefined,403,"partner financial compatibility reader retains privileged guard");
  for(const bad of ["parentId=2147483648","parentId=1&parentId=2","period=2026-99","search=%0A"])
    await check("admin","GET",`/api/revenue/residual-group-scope?${bad}`,undefined,400,`financial invalid scope rejected: ${bad}`);
  assert.equal(group.memberIds.length,502);
  assert.ok(group.residualIds.includes(residual.id));
  assert.ok(!JSON.stringify(group).includes(groupMid.mid));
  const sessionIds:number[]=[];
  for(let n=0;n<4;n++){
    const result=await h.pool.query(`INSERT INTO live_chats(session_id,contact_id,created_at,last_message_at)
      VALUES($1,$2,$3,$3) RETURNING id`,[`${h.prefix}-session-${n}`,contact.id,`2026-10-07T12:00:0${n}.123Z`]);
    sessionIds.push(result.rows[0].id);
  }
  const siteFirst=await check("admin","GET","/api/inbox/items?channel=site&limit=2",undefined,200,"stable local session cursor first window");
  assert.equal(siteFirst.items.length,2);assert.ok(siteFirst.nextCursor);
  await h.pool.query(`INSERT INTO live_chats(session_id,contact_id) VALUES($1,$2)`,[`${h.prefix}-after-pin`,contact.id]);
  await h.pool.query(`UPDATE live_chats SET last_message_at=NOW() WHERE id=$1`,[sessionIds[0]]);
  await h.pool.query(`INSERT INTO live_chat_messages(chat_id,sender_type,content) VALUES($1,'visitor','Captured after pin')`,[sessionIds[0]]);
  const siteSecond=await check("admin","GET",`/api/inbox/items?channel=site&limit=2&cursor=${encodeURIComponent(siteFirst.nextCursor)}`,undefined,200,"stable local session window under insertion and activity");
  assert.deepEqual([...siteFirst.items,...siteSecond.items].map((item:any)=>Number(item.id.split(":").at(-1))).sort((a:number,b:number)=>a-b),sessionIds);
  assert.ok([...siteFirst.items,...siteSecond.items].every((item:any)=>item.body===""),"session preview is not captured message content");
  const ids:number[]=[];
  for(let n=0;n<112;n++) {
    const c=(await h.db.insert(contacts).values({firstName:h.prefix,lastName:`portfolio-${n}`,
      email:`${h.prefix}-portfolio-${n}@example.test`,phone:"",recordClass:"production",assignedTo:h.email("agent")}).returning())[0];
    ids.push(c.id);
    await h.db.insert(merchantMids).values({contactId:c.id,mid:`${h.prefix}-p${n}`,status:"active",activatedAt:new Date()});
  }
  const emitted:number[]=[];
  let total:number|undefined;
  for(const offset of [0,50,100]) {
    const page=await check("agent","GET",`/api/portfolio?limit=50&offset=${offset}&sort=risk`,undefined,200,"complete supported Portfolio continuation");
    assert.equal(typeof page.total,"number");total ??= page.total;assert.equal(page.total,total);
    emitted.push(...page.data.map((merchant:any)=>merchant.id));
  }
  assert.equal(emitted.length,total);
  assert.equal(new Set(emitted).size,emitted.length);
  assert.ok(ids.every(id=>emitted.includes(id)));
  const operationSource = `=C4 model source ${h.prefix}`;
  const cohortDate = new Date(Date.now() - 86_400_000);
  const [observedLead, archivedLead, futureLead] = await h.db.insert(contacts).values([
    {firstName:"C4",lastName:"cohort",email:`${h.prefix}-cohort@example.test`,phone:"",companyName:"C4 report cohort",recordClass:"production",assignedTo:h.email("agent"),utmSource:operationSource,createdAt:cohortDate},
    {firstName:"C4",lastName:"archived",email:`${h.prefix}-archived@example.test`,phone:"",companyName:"C4 excluded archived",recordClass:"production",utmSource:operationSource,createdAt:cohortDate,archivedAt:new Date()},
    {firstName:"C4",lastName:"future",email:`${h.prefix}-future@example.test`,phone:"",companyName:"C4 excluded future",recordClass:"production",utmSource:operationSource,createdAt:new Date(Date.now()+86_400_000)},
  ]).returning();
  const [wonDeal] = await h.db.insert(deals).values([
    {contactId:observedLead.id,recordClass:"production",pipeline:"sales",stage:"Closed Won",owner:h.email("agent")},
    {contactId:observedLead.id,recordClass:"production",pipeline:"sales",stage:"Call Booked",owner:h.email("agent"),archivedAt:new Date()},
  ]).returning();
  const {tasks: reportTasks,auditLogs: reportAudit}=await import("../shared/schema");
  const [pendingTask, completedTask] = await h.db.insert(reportTasks).values([
    {title:"C4 canonical overdue",contactId:observedLead.id,assignedTo:h.email("agent"),status:"completed",authorityState:"open",dueDate:cohortDate},
    {title:"C4 excluded completed",contactId:observedLead.id,assignedTo:h.email("agent"),status:"pending",authorityState:"completed",dueDate:cohortDate},
  ]).returning();
  await h.db.insert(reportAudit).values({action:"c4_owned_queue_failure",entityType:"queue",
    details:{privateTestDetail:"Do not expose report raw details"},createdAt:cohortDate});
  for (const role of ["admin","manager"]) {
    const body=await check(role,"GET","/api/reporting/operations?days=30&adSpend=10.01",undefined,200,"authorized Operations model and exact provenance");
    const report=operationsReportSchema.parse(body);
    const observed=report.cplBySource.find(row=>row.source===operationSource)!;
    assert.equal(observed.leads,1,"archived/future cohort contacts excluded");
    assert.equal(observed.bookedCalls,0,"archived current-stage deal excluded");
    assert.equal(observed.signedMerchants,1);
    const leadTotal=report.cplBySource.reduce((total,row)=>total+row.leads,0);
    assert.ok(Math.abs(observed.cpl!-10.01/leadTotal)<1e-12,"model precision is not integer-dollar rounded");
    assert.equal(report.meta.period.timezone,"UTC");
    assert.equal(new Date(report.meta.period.endExclusive).getTime()-new Date(report.meta.period.startInclusive).getTime(),30*86400000);
    assert.equal(report.meta.snapshotConsistency,"unavailable");
    assert.equal(report.meta.spendAllocation.authoritativeSpendSource,false);
    assert.ok(report.overdueTasks.some(task=>task.id===pendingTask.id),"canonical authority state overrides legacy completed");
    assert.ok(!report.overdueTasks.some(task=>task.id===completedTask.id),"canonical completed is not a pending task");
    assert.equal(report.incidentSummary.mostRecentQueueIncident?.category,"c4_owned_queue_failure");
    assert.ok(!JSON.stringify(report).includes("Do not expose report raw details"));
  }
  for (const role of ["agent","other","merchant","partner"])
    await check(role,"GET","/api/reporting/operations?days=30&adSpend=10.01",undefined,403,"Operations hub role guard precedes report read");
  for (const invalid of ["-10","NaN","Infinity","1e6","10abc","1.001","999999999999999999999","1&adSpend=2"])
    await check("admin","GET",`/api/reporting/operations?days=30&adSpend=${invalid}`,undefined,400,"invalid model input is rejected, not zero");
  const zero=operationsReportSchema.parse(await check("admin","GET","/api/reporting/operations?days=7&adSpend=0",undefined,200,"zero user model has unavailable cost ratios"));
  assert.ok(zero.cplBySource.every(row=>row.cpl===null&&row.cpb===null&&row.cps===null));
  const emptyNps = npsStatsReadSchema.parse(await check("admin","GET","/api/nps/stats",undefined,200,"empty eligible NPS sample is unassessed, not zero"));
  assert.equal(emptyNps.scored,0);assert.equal(emptyNps.avgScore,null);assert.equal(emptyNps.npsScore,null);
  const {npsResponses}=await import("../shared/schema");
  const [testNpsContact]=await h.db.insert(contacts).values({
    firstName:"C4",lastName:"excluded NPS test",email:`${h.prefix}-nps-test@example.test`,phone:"",recordClass:"test",
  }).returning();
  const npsDate=new Date(Date.now()-86_400_000);
  for (const [index,score,submitted] of [
    [0,10,true],[1,0,true],[2,null,true],[3,11,true],[4,null,false],[5,10,false],
  ] as const) await h.db.insert(npsResponses).values({
    token:`${h.prefix}-nps-${index}`,contactId:observedLead.id,dayTrigger:30,score,
    createdAt:npsDate,submittedAt:submitted?npsDate:null,
  });
  for (const [index,contactId,createdAt,submittedAt] of [
    [6,archivedLead.id,npsDate,npsDate],[7,testNpsContact.id,npsDate,npsDate],[8,null,npsDate,npsDate],
    [9,observedLead.id,new Date(Date.now()+86_400_000),npsDate],
    [10,observedLead.id,npsDate,new Date(Date.now()+86_400_000)],
  ] as const) await h.db.insert(npsResponses).values({
    token:`${h.prefix}-nps-${index}`,contactId,dayTrigger:30,score:10,createdAt,submittedAt,
  });
  for(const role of ["admin","manager"]) {
    const sample=npsStatsReadSchema.parse(await check(role,"GET","/api/nps/stats",undefined,200,"NPS valid score denominator and management production scope"));
    assert.equal(sample.total,6);assert.equal(sample.submitted,4);assert.equal(sample.scored,2);
    assert.equal(sample.invalidSubmitted,2);assert.equal(sample.avgScore,5);assert.equal(sample.npsScore,0);
    assert.equal(sample.promoters,1);assert.equal(sample.detractors,1);assert.equal(sample.passives,0);
    assert.equal(sample.metadata.snapshotConsistency,"single_statement");
    const records=npsRecordsReadSchema.parse(await check(role,"GET","/api/nps",undefined,200,"NPS independent records match declared class/archive/future scope"));
    assert.equal(records.length,6);assert.equal(new Set(records.map(r=>r.id)).size,6);
  }
  for(const role of ["agent","other","merchant","partner"]) for(const endpoint of ["/api/nps","/api/nps/stats"])
    await check(role,"GET",endpoint,undefined,403,"NPS management read denied before observation");
  const [scoreAgent]=await h.db.insert(agentTable).values({
    firstName:h.prefix,lastName:"Recorded volume fixture",email:`${h.prefix}-score@example.test`,userId:h.userId("agent"),
  }).returning();
  await h.db.insert(deals).values({
    title:`${h.prefix} captured processing volume`,contactId:observedLead.id,pipeline:"sales",stage:"Closed Won",
    owner:`${scoreAgent.firstName} ${scoreAgent.lastName}`,recordClass:"production",totalVolume:"10.10",
  });
  for(const role of ["admin","manager","agent"]){
    const score=await check(role,"GET","/api/leaderboard?period=all",undefined,200,"recorded processing volume is not revenue; scoped scoreboard source metadata");
    const entry=score.entries.find((r:any)=>r.agentId===scoreAgent.id);
    assert.equal(entry.revenueManaged,10.1);
    assert.equal(entry.prevRevenueManaged,null,"No previous monetary observation is not zero");
    assert.equal(entry.isCurrentUser,role==="agent","Current-user marker is typed user ID, not email");
    assert.equal(score.read.revenueMeasure,"stored_closed_won_processing_volume_not_revenue_or_native_receipts");
    assert.equal(score.read.attributionCompleteness,"ambiguous_legacy_aliases","Equal historical payee labels must not establish ranking attribution");
    assert.equal(score.read.sources.callLogs,"loaded");
    assert.equal(score.read.sources.creatorEvents,"loaded");
    assert.ok(Number.isFinite(Date.parse(score.read.asOf))&&score.read.timezone);
  }
  for(const role of ["merchant","partner"])
    await check(role,"GET","/api/leaderboard?period=all",undefined,403,"Non-dashboard scoreboard read denied");
  for(const period of ["invalid","month&period=week"])
    await check("agent","GET",`/api/leaderboard?period=${period}`,undefined,400,"Invalid or duplicate scoreboard period denied");
  for(const source of ["callLogs","creatorEvents"]){
    leaderboardReadFault=source;
    const score=await check("agent","GET","/api/leaderboard?period=all",undefined,200,`Independent ${source} fault is unavailable, not zero; successful siblings retained`);
    const entry=score.entries.find((r:any)=>r.agentId===scoreAgent.id);
    assert.equal(score.read.sources[source],"failed");
    assert.equal(entry[source==="callLogs"?"callsMade":"contactsCreated"],null);
    assert.equal(entry.revenueManaged,10.1);
  }
  leaderboardReadFault=undefined;
  assert.deepEqual(leaderboardFaults,["callLogs","creatorEvents"],"Both named query faults actually executed");
  await h.db.insert(deals).values(Array.from({length:2001},(_,n)=>({
    title:`${h.prefix} capped scoreboard population ${n}`,pipeline:"sales",stage:"New Lead",recordClass:"production",
  })));
  const cappedScore=await check("agent","GET","/api/leaderboard?period=all",undefined,200,"Reader cap is explicit incompleteness, not whole-team statistics");
  assert.equal(cappedScore.read.completeness,"incomplete_deal_population");
  assert.ok(cappedScore.read.totalDealCount>cappedScore.read.loadedDealCount);
  const payoutFixtures=(await h.pool.query(`INSERT INTO agent_payouts(agent_user_id,period_month,agent_share,gross_residual,status)
    VALUES($1,'2098-11','0.10','0.00','paid'),($2,'2098-11','0.20','0.00','paid'),
      ($3,'2098-11','','','pending'),($4,'2098-11','0.00','0.00','pending') RETURNING id`,
    [h.userId("agent"),h.userId("other"),h.userId("manager"),h.userId("admin")])).rows;
  for(const role of ["admin","manager"]){
    const ledger=await check(role,"GET","/api/payouts?month=2098-11&status=paid&read=1",undefined,200,"Existing guarded payout reader exposes exact stored allocations, not settlement");
    assert.equal(ledger.groups[0].totalAgent,"0.30");assert.equal(ledger.groups[0].totalGross,"0.00");
    assert.equal(ledger.read.currency,"unknown");assert.equal(ledger.read.periodTimezone,"unknown");
    assert.equal(ledger.read.population,"administrative_global_ledger");
    assert.equal(ledger.read.monetaryMeaning,"stored_allocation_not_native_transfer_or_settlement");
    assert.equal(ledger.read.completeness,"complete_returned_ledger_rows");
    assert.deepEqual(ledger.rows.map((r:any)=>r.id),payoutFixtures.slice(0,2).map((r:any)=>r.id));
  }
  const unknownLedger=await check("manager","GET","/api/payouts?month=2098-11&status=pending&read=1",undefined,200,"Missing stored allocations stay unavailable while observed zero stays zero");
  assert.equal(unknownLedger.groups[0].totalAgent,null);assert.equal(unknownLedger.groups[0].totalGross,null);
  assert.equal(unknownLedger.rows.find((r:any)=>r.agentUserId===h.userId("admin")).agentShare,"0.00");
  const legacyLedger=await check("manager","GET","/api/payouts?month=2098-11&status=paid",undefined,200,"Legacy payout array contract retained");
  assert.ok(Array.isArray(legacyLedger));assert.equal(legacyLedger.length,2);
  for(const role of ["agent","other","merchant","partner"])
    await check(role,"GET","/api/payouts?month=2098-11&read=1",undefined,403,"Payout metadata does not widen ledger role authority");
  for(const query of ["month=2098-99","month=2098-11&month=2098-10","status=paid&status=pending","read=2"])
    await check("admin","GET",`/api/payouts?${query}`,undefined,400,"Malformed/duplicate ledger filters cannot broaden scope");
  const reviewFixtures=(await h.pool.query(`INSERT INTO review_queue(source_type,source_id,status,metadata)
    VALUES('quiz',101,'pending',$1::jsonb),('quiz',102,'approved',$2::jsonb) RETURNING id`,
    [JSON.stringify({contactName:`${h.prefix} pending read fixture`}),JSON.stringify({contactName:`${h.prefix} approved read fixture`})])).rows;
  for(const role of ["admin","manager"]){
    const pending=await check(role,"GET","/api/review-queue?status=pending",undefined,200,"Authorized recorded Review Queue status read");
    assert.ok(pending.some((r:any)=>r.id===reviewFixtures[0].id));
    assert.ok(!pending.some((r:any)=>r.id===reviewFixtures[1].id));
    const aggregate=await check(role,"GET","/api/review-queue/pending-count",undefined,200,"Independent Review Queue aggregate source");
    assert.ok(aggregate.pending>=1&&aggregate.approved>=1);
    const checklist=await check(role,"GET","/api/review-queue/checklist-items",undefined,200,"Independent Review Queue checklist source");
    assert.ok(checklist.length>0&&checklist.every((r:any)=>r.key&&r.label));
  }
  for(const role of ["agent","other","merchant","partner"])
    await check(role,"GET",`/api/review-queue/${reviewFixtures[0].id}`,undefined,403,"Review record read does not expand role authority");
  for(const query of ["status=invalid","status=pending&status=approved","status="])
    await check("manager","GET",`/api/review-queue?${query}`,undefined,400,"Invalid/conflicting Review Queue status cannot silently broaden");
  const boarded=await h.db.insert(deals).values(Array.from({length:2050},()=>({
    contactId:contact.id,owner:h.email("agent"),recordClass:"production" as const,
    pipeline:"onboarding",stage:"Application Submitted",boardingStatus:"submitted",
    boardingSubmittedAt:new Date("2026-10-01T12:00:00Z"),
  }))).returning();
  const exceptional=await h.db.insert(deals).values([
    {contactId:foreign.id,owner:h.email("other"),recordClass:"production" as const},
    {contactId:contact.id,owner:null,recordClass:"production" as const},
    {contactId:contact.id,owner:h.email("agent"),recordClass:"production" as const,archivedAt:new Date()},
    {contactId:contact.id,owner:h.email("agent"),recordClass:"test" as const},
  ].map(row=>({...row,pipeline:"onboarding",stage:"Application Submitted",boardingStatus:"submitted",
    boardingSubmittedAt:new Date("2026-10-01T12:00:00Z")}))).returning();
  const ownedIds=new Set(boarded.map(row=>row.id));
  for(const role of ["admin","manager","agent","other"]){
    const read=await check(role,"GET","/api/boarding/submissions?status=submitted",undefined,200,
      "Complete recorded boarding reader preserves A owner/class/archive scope, not native refresh");
    const present=new Set(read.submissions.map((row:any)=>row.dealId));
    assert.equal(boarded.filter(row=>present.has(row.id)).length,role==="other"?0:2050);
    assert.equal(present.has(exceptional[0].id),role!=="agent");
    assert.equal(present.has(exceptional[1].id),true,"Existing A unassigned visibility retained");
    for(const excluded of exceptional.slice(2))assert.equal(present.has(excluded.id),false);
    assert.equal(read.counts.submitted,read.submissions.length);
    assert.equal(read.total,read.submissions.length);
    assert.equal(read.read.completeness,"complete_authorized_recorded_cohort");
    assert.equal(read.read.consistency,"one_repeatable_read_cohort");
    assert.ok(Number.isFinite(new Date(read.read.asOf).getTime()));
    assert.match(read.snapshot,/^[a-f0-9]{64}$/);
    const owned=read.submissions.filter((row:any)=>ownedIds.has(row.dealId));
    assert.deepEqual(owned.map((row:any)=>row.dealId),role==="other"?[]:boarded.map(row=>row.id).sort((a,b)=>b-a));
    for(const row of owned){
      assert.equal(row.contactId,contact.id);assert.equal(row.relatedData.contact,"resolved");
      assert.match(row.merchantName,new RegExp(h.prefix));assert.equal("mid" in row,false);
    }
  }
  for(const query of ["status=bad","status=submitted&status=approved","status="])
    await check("admin","GET",`/api/boarding/submissions?${query}`,undefined,400,"Invalid/conflicting boarding selection cannot broaden");
  for(const role of ["merchant","partner"])
    await check(role,"GET","/api/boarding/submissions",undefined,403,"Portal cannot mount employee boarding population");
  const document=(await h.db.insert(documents).values({contactId:contact.id,type:"statement",
    fileName:`${h.prefix}-private.txt`,category:"Other",status:"pending"}).returning())[0];
  const statement=(await h.db.insert(statementReviews).values({documentId:document.id,contactId:contact.id,
    dealId:deal.id,status:"received",version:0}).returning())[0];
  for(const role of ["admin","manager"]){
    const docs=await check(role,"GET","/api/merchant-documents",undefined,200,"Real document metadata reader, no parse/preview/delete");
    assert.ok(docs.some((row:any)=>row.id===document.id&&row.contactId===contact.id));
  }
  await check("agent","GET","/api/merchant-documents",undefined,403,"Denied vault read is not an empty result");
  for(const role of ["admin","manager","agent","other"]){
    const reviews=await check(role,"GET","/api/statement-reviews",undefined,200,"Statement version and typed relationships remain scoped");
    assert.equal(reviews.some((row:any)=>row.id===statement.id),role!=="other");
    if(role!=="other"){
      const row=reviews.find((row:any)=>row.id===statement.id);
      assert.equal(row.version,0);assert.equal(row.documentId,document.id);assert.equal(row.relatedData.contact,"ok");
    }
  }
  assert.equal(h.externalCalls(),0,"No real provider invocation is authorized");
  const {testimonialSubmissions}=await import("../shared/schema");
  const storyRows=await h.db.insert(testimonialSubmissions).values(
    ["pending","approved","rejected"].map(status=>({
      name:`${h.prefix} ${status} story read`,email:"story@c4.example.test",
      story:"Owned isolated story reader fixture",status,publish:false,
    }))).returning();
  for(const role of ["admin","manager"] as const){
    for(const status of ["pending","approved","rejected","all"]){
      const data=await check(role,"GET",`/api/testimonial-submissions?status=${status}`,undefined,200,
        "Staff story reader retains exact selected-status population");
      assert.deepEqual(data.map((row:any)=>row.id).sort((a:number,b:number)=>a-b),
        storyRows.filter(row=>status==="all"||row.status===status).map(row=>row.id).sort((a,b)=>a-b));
    }
    const data=await check(role,"GET",`/api/testimonial-submissions/${storyRows[0].id}`,undefined,200,
      "Exact story ID reader");
    assert.equal(data.id,storyRows[0].id);
  }
  for(const role of ["agent","other","merchant","partner"] as const){
    await check(role,"GET","/api/testimonial-submissions",undefined,403,"Non-staff story collection denied");
    await check(role,"GET",`/api/testimonial-submissions/${storyRows[0].id}`,undefined,403,"Non-staff object read denied");
    await check(role,"PATCH",`/api/testimonial-submissions/${storyRows[0].id}`,
      {status:"approved",publish:true},403,"Non-staff moderation denied before writes");
  }
  for(const raw of ["status=","status=wrong","status=pending&status=approved"])
    await check("admin","GET",`/api/testimonial-submissions?${raw}`,undefined,400,"Invalid/conflicting status does not broaden read");
  for(const id of ["0","-1","1.5","bad"])
    await check("admin","GET",`/api/testimonial-submissions/${id}`,undefined,400,"Malformed story object ID denied");
  const unchanged=await h.db.select().from(testimonialSubmissions);
  assert.equal(unchanged.find(row=>row.id===storyRows[0].id)?.status,"pending");
  assert.equal(unchanged.some(row=>row.publish),false,"Denied moderation has no publication flag effect");
  assert.equal(h.externalCalls(),0,"Story readers and denied handlers have no external effects");
  const {rfis}=await import("../shared/schema");
  const rfiContacts=await h.db.insert(contacts).values([
    {firstName:h.prefix,lastName:"RFI own",email:`${h.prefix}-rfi-own@example.test`,phone:"",assignedTo:h.email("agent"),recordClass:"production"},
    {firstName:h.prefix,lastName:"RFI foreign",email:`${h.prefix}-rfi-foreign@example.test`,phone:"",assignedTo:h.email("other"),recordClass:"production"},
    {firstName:h.prefix,lastName:"RFI archived",email:`${h.prefix}-rfi-archive@example.test`,phone:"",assignedTo:h.email("agent"),recordClass:"production",archivedAt:new Date()},
    {firstName:h.prefix,lastName:"RFI test",email:`${h.prefix}-rfi-test@example.test`,phone:"",assignedTo:h.email("agent"),recordClass:"test"},
  ]).returning();
  const rfiRows=await h.db.insert(rfis).values([
    ...rfiContacts.map((contact,index)=>({contactId:contact.id,subject:`${h.prefix} RFI ${index}`,status:"Open",createdAt:new Date("2026-10-01T00:00:00Z")})),
    {subject:`${h.prefix} unlinked RFI`,status:"Waiting on Merchant",createdAt:new Date("2026-10-01T00:00:00Z")},
  ]).returning();
  for(const [role,expected] of [
    ["admin",[rfiRows[4].id,rfiRows[1].id,rfiRows[0].id]],
    ["manager",[rfiRows[4].id,rfiRows[1].id,rfiRows[0].id]],
    ["agent",[rfiRows[0].id]],["other",[rfiRows[1].id]],
  ] as const){
    const result=await check(role,"GET","/api/rfis",undefined,200,"RFI collection shares exact A resource authority; outer ID remains correlated");
    assert.deepEqual(result.filter((row:any)=>rfiRows.some(expected=>expected.id===row.id)).map((row:any)=>row.id),expected);
    const own=await check(role,"GET",`/api/rfis?contactId=${rfiContacts[0].id}`,undefined,200,"RFI exact contact filter never widens actor scope");
    assert.deepEqual(own.map((row:any)=>row.id),role==="other"?[]:[rfiRows[0].id]);
  }
  for(const role of ["merchant","partner"])await check(role,"GET","/api/rfis",undefined,403,"Portal denied before RFI collection read");
  for(const query of ["contactId=","contactId=bad","contactId=0","contactId=1&contactId=2"])
    await check("admin","GET",`/api/rfis?${query}`,undefined,400,"Invalid/conflicting RFI context never requests broader collection");
  const {rfiCommandReceipts,reviewQueue,notifications}=await import("../shared/schema");
  // Fresh migration was applied by the isolation owner before DB imports.
  // Replay only this new idempotent DDL in the already-proved private target.
  const rfiMigration=await readFile("migrations/0347_rfi_work_commands.sql","utf8");
  const migrationRows=await h.db.execute(sql`SELECT hash FROM drizzle.__drizzle_migrations WHERE hash=${createHash("sha256").update(rfiMigration).digest("hex")}`);
  assert.equal(migrationRows.rows.length,1,"Fresh private migration has its exact source hash");
  await h.db.execute(sql.raw(rfiMigration));
  const actors=await h.db.select().from(users);
  function rfiPacket(role:string,fields:Record<string,unknown>){
    const actor=actors.find(row=>row.id===h.userId(role as any))!;
    return {commandId:randomUUID(),expectedActorId:actor.id,expectedAccountVersion:actor.accountVersion,...fields};
  }
  const createRfi=rfiPacket("agent",{subject:`${h.prefix} durable local RFI`,contactId:rfiContacts[0].id});
  for(const role of ["merchant","partner"])
    await check(role,"POST","/api/rfis",createRfi,403,"Portal denied before any RFI command effect");
  await check("agent","POST","/api/rfis",{subject:"No intent"},400,"RFI requires captured actor and UUIDv4");
  await check("agent","POST","/api/rfis",{...createRfi,commandId:"00000000-0000-1000-8000-000000000000"},400,"Non-v4 intent denied");
  await check("agent","POST","/api/rfis",{...createRfi,priority:"unregistered"},400,"Invalid RFI input denied before effects");
  await check("agent","POST","/api/rfis",{...createRfi,expectedActorId:h.userId("other")},409,"Captured RFI actor cannot change");
  await check("agent","POST","/api/rfis",{...createRfi,expectedAccountVersion:createRfi.expectedAccountVersion+1},409,"Stale RFI account fence denied");
  for(const contact of rfiContacts.slice(1))
    await check("agent","POST","/api/rfis",rfiPacket("agent",{subject:"Denied linked RFI",contactId:contact.id}),404,"RFI foreign/archive/test relation denied");
  await check("agent","POST","/api/rfis",rfiPacket("agent",{subject:"No relationship"}),404,"Agent cannot create an unlinked RFI");
  await check("admin","POST","/api/rfis",rfiPacket("admin",{subject:"No name authority",contactId:rfiContacts[0].id,assignedTo:"Team Member Display Name"}),409,"RFI assignment resolves current eligible account, not a name");
  const createPair=await Promise.all([
    h.request("agent","POST","/api/rfis",createRfi),h.request("agent","POST","/api/rfis",createRfi),
  ]);
  assert.deepEqual(createPair.map(result=>result.status).sort(),[200,201]);
  const createdRfi=createPair[0].body;
  rows.push({role:"agent",method:"POST",path:"/api/rfis",status:[200,201],note:"Concurrent same-intent RFI creation: one record and replay"});
  assert.equal(createdRfi.authorityFence,0);assert.equal(createdRfi.command.nativeDelivery,"not_attempted");
  const localEffects=async(id:number)=>({
    receipts:(await h.db.select().from(rfiCommandReceipts).where(eq(rfiCommandReceipts.rfiId,id))).length,
    queue:(await h.db.select().from(reviewQueue).where(and(eq(reviewQueue.sourceType,"rfi"),eq(reviewQueue.sourceId,id)))).length,
    notifications:(await h.db.select().from(notifications)).filter(row=>(row.metadata as any)?.rfiId===id).length,
    audit:(await h.db.select().from(auditLogs).where(and(eq(auditLogs.entityType,"rfi"),eq(auditLogs.entityId,id)))).length,
  });
  assert.deepEqual(await localEffects(createdRfi.id),{receipts:1,queue:1,notifications:1,audit:1});
  await check("agent","POST","/api/rfis",{...createRfi,subject:"Changed retained payload"},409,"Same RFI key with changed payload denied");
  assert.deepEqual(await localEffects(createdRfi.id),{receipts:1,queue:1,notifications:1,audit:1});
  const editPath=`/api/rfis/${createdRfi.id}`;
  await check("other","PUT",editPath,rfiPacket("other",{expectedFence:0,status:"Closed"}),404,"Foreign RFI write is denied before effects");
  await check("agent","PUT",editPath,rfiPacket("agent",{status:"Closed"}),409,"Missing RFI record version denied");
  const responseIntent=rfiPacket("agent",{expectedFence:0,response:"Owned local response",status:"Responded"});
  const responded=await check("agent","PUT",editPath,responseIntent,200,"RFI response is local persisted fact, not native delivery");
  assert.equal(responded.status,"Responded");assert.equal(responded.authorityFence,1);
  assert.ok(responded.respondedAt);assert.equal(responded.command.nativeDelivery,"not_attempted");
  const replayed=await check("agent","PUT",editPath,responseIntent,200,"Same response intent replays despite advanced current version");
  assert.equal(replayed.command.replayed,true);assert.equal(replayed.authorityFence,1);
  assert.deepEqual(await localEffects(createdRfi.id),{receipts:2,queue:1,notifications:2,audit:2});
  await check("agent","PUT",editPath,{...responseIntent,response:"Changed response"},409,"Changed response under same UUID never replaces original");
  await check("agent","PUT",editPath,rfiPacket("agent",{expectedFence:0,status:"Closed"}),409,"Stale RFI version requires an explicit new read/intent");
  const concurrentEdits=await Promise.all([
    h.request("agent","PUT",editPath,rfiPacket("agent",{expectedFence:1,status:"Closed"})),
    h.request("agent","PUT",editPath,rfiPacket("agent",{expectedFence:1,status:"Waiting on Merchant"})),
  ]);
  assert.deepEqual(concurrentEdits.map(result=>result.status).sort(),[200,409]);
  rows.push({role:"agent",method:"PUT",path:editPath,status:[200,409],note:"Distinct RFI intents at one record fence: one wins, one conflicts"});
  const currentRfi=await check("agent","GET",editPath,undefined,200,"RFI command exact authorized readback");
  await check("agent","PUT",editPath,rfiPacket("agent",{expectedFence:currentRfi.authorityFence,status:"Open"}),200,"Explicit local RFI reopening retains existing status policy");
  const lostIntent=rfiPacket("agent",{subject:`${h.prefix} lost reply RFI`,contactId:rfiContacts[0].id});
  const faultStart=h.responseFaultEvents.length;
  h.loseNextSuccessfulResponse("POST","/api/rfis","truncate");
  await assert.rejects(()=>h.request("agent","POST","/api/rfis",lostIntent));
  assert.ok(h.responseFaultEvents.slice(faultStart).some(event=>event.event==="executed"&&event.status===201),"Post-commit RFI reply loss actually executed");
  const recoveredRfi=await check("agent","POST","/api/rfis",lostIntent,200,"Lost RFI acceptance reply replays one frozen durable intent");
  assert.equal(recoveredRfi.command.replayed,true);
  assert.deepEqual(await localEffects(recoveredRfi.id),{receipts:1,queue:1,notifications:1,audit:1});
  await h.db.update(contacts).set({archivedAt:new Date()}).where(eq(contacts.id,rfiContacts[0].id));
  await check("agent","POST","/api/rfis",lostIntent,404,"RFI receipt replay rechecks current target authorization");
  await h.db.update(contacts).set({archivedAt:null}).where(eq(contacts.id,rfiContacts[0].id));
  assert.equal(h.externalCalls(),0,"All local RFI commands have zero real or attempted native/provider execution");
  // Employee creation extends the existing ticket issue/generation authority.
  // The public/inbound producer is intentionally not exercised or replaced.
  // Fresh employee/rep/contact topology: earlier financial attribution fixtures
  // are immutable evidence, not an eligible work-assignment fixture.
  const ticketRole="ticket-agent";
  const [ticketEmployee]=await h.db.insert(users).values({id:h.userId(ticketRole),email:h.email(ticketRole),
    passwordHash:h.passwordHash,role:"agent",authProvider:"local",emailVerified:new Date()}).returning();
  await h.db.insert(agentTable).values({firstName:h.prefix,lastName:"Ticket Employee",
    email:ticketEmployee.email!,userId:ticketEmployee.id,status:"active"});
  const ticketContacts=await h.db.insert(contacts).values([
    {firstName:h.prefix,lastName:"Ticket own",email:`${h.prefix}-ticket-own@example.test`,phone:"",assignedTo:ticketEmployee.email,recordClass:"production"},
    {firstName:h.prefix,lastName:"Ticket foreign",email:`${h.prefix}-ticket-foreign@example.test`,phone:"",assignedTo:h.email("other"),recordClass:"production"},
    {firstName:h.prefix,lastName:"Ticket archived",email:`${h.prefix}-ticket-archive@example.test`,phone:"",assignedTo:ticketEmployee.email,recordClass:"production",archivedAt:new Date()},
    {firstName:h.prefix,lastName:"Ticket test",email:`${h.prefix}-ticket-test@example.test`,phone:"",assignedTo:ticketEmployee.email,recordClass:"test"},
  ]).returning();
  await h.login(ticketRole);
  const ticketPacket=(fields:Record<string,unknown>={})=>({
    commandId:randomUUID(),expectedActorId:ticketEmployee.id,expectedAccountVersion:ticketEmployee.accountVersion,
    subject:`${h.prefix} local ticket intent`,description:"Local-only ticket description",contactId:ticketContacts[0].id,...fields});
  for(const role of ["merchant","partner"])await check(role,"POST","/api/tickets",{},403,"Portal denied before employee ticket intent parsing/effects");
  await check(ticketRole,"POST","/api/tickets",{subject:"Missing intent"},400,"Ticket creation requires captured intent");
  await check(ticketRole,"POST","/api/tickets",ticketPacket({description:undefined}),400,"Missing required description is rejected before SQL/effects");
  await check(ticketRole,"POST","/api/tickets",ticketPacket({priority:"invented"}),400,"Ticket creation rejects unknown priority");
  await check(ticketRole,"POST","/api/tickets",ticketPacket({status:"Resolved"}),400,"Creation cannot bypass canonical initial state");
  await check(ticketRole,"POST","/api/tickets",ticketPacket({expectedActorId:"different-actor"}),409,"Ticket creation pins captured actor");
  await check(ticketRole,"POST","/api/tickets",ticketPacket({expectedAccountVersion:999999}),409,"Ticket creation pins account authority");
  for(const contactId of [null,ticketContacts[1].id,ticketContacts[2].id,ticketContacts[3].id])
    await check(ticketRole,"POST","/api/tickets",ticketPacket({contactId}),404,"Unlinked/foreign/archive/class ticket creation denied before effects");
  await check(ticketRole,"POST","/api/tickets",ticketPacket({assignedTo:"Display Name"}),409,"Ticket assignee is an eligible account identity, not display text");
  const ticketIntent=ticketPacket();
  const ticketCreates=await Promise.all([h.request(ticketRole,"POST","/api/tickets",ticketIntent),h.request(ticketRole,"POST","/api/tickets",ticketIntent)]);
  assert.deepEqual(ticketCreates.map(result=>result.status).sort(),[200,201]);
  const createdTicket=ticketCreates.find(result=>result.status===201)!.body;
  assert.equal(createdTicket.authorityState,"open");assert.equal(createdTicket.authorityFence,0);
  assert.equal(createdTicket.assignedTo,h.email(ticketRole));
  const ticketEffects=async(id:number)=>(await h.pool.query(`SELECT
    (SELECT count(*)::int FROM ticket_authority_events WHERE ticket_id=$1 AND event_type='creation_intent_accepted') AS intents,
    (SELECT count(*)::int FROM ticket_authority_events WHERE ticket_id=$1 AND event_type='created') AS created,
    (SELECT count(*)::int FROM notifications WHERE metadata->>'ticketId'=$1::text AND title='Ticket Assigned') AS notifications,
    (SELECT count(*)::int FROM audit_logs WHERE entity_type='ticket' AND entity_id=$1 AND action='ticket_created') AS audit`,[id])).rows[0];
  assert.deepEqual(await ticketEffects(createdTicket.id),{intents:1,created:1,notifications:1,audit:1});
  const uppercaseTicketReplay=await check(ticketRole,"POST","/api/tickets",{...ticketIntent,commandId:ticketIntent.commandId.toUpperCase()},200,"UUID casing is one frozen ticket intent");
  assert.equal(uppercaseTicketReplay.command.replayed,true);
  assert.deepEqual(await ticketEffects(createdTicket.id),{intents:1,created:1,notifications:1,audit:1});
  await check(ticketRole,"POST","/api/tickets",{...ticketIntent,priority:"Urgent"},409,"Changed ticket payload cannot reuse original intent");
  const retainedTicket=await check(ticketRole,"POST","/api/tickets",{...ticketIntent,commandId:crypto.randomUUID()},200,"Independent unchanged creation explicitly retains existing active issue");
  assert.equal(retainedTicket.id,createdTicket.id);assert.equal(retainedTicket.command.reused,true);
  assert.deepEqual(await ticketEffects(createdTicket.id),{intents:2,created:1,notifications:1,audit:1});
  await check(ticketRole,"POST","/api/tickets",{...ticketIntent,commandId:crypto.randomUUID(),description:"Changed existing issue"},409,"Active issue reuse must not falsely acknowledge changed fields");
  assert.deepEqual(await ticketEffects(createdTicket.id),{intents:2,created:1,notifications:1,audit:1});
  const advancedTicket=await check(ticketRole,"PUT",`/api/tickets/${createdTicket.id}`,{
    commandId:crypto.randomUUID(),expectedFence:0,expectedActorId:ticketIntent.expectedActorId,
    expectedAccountVersion:ticketIntent.expectedAccountVersion,status:"In Progress"},200,"Existing B edit advances retained ticket version");
  const creationReplay=await check(ticketRole,"POST","/api/tickets",ticketIntent,200,"Original creation replays after an authorized later edit, without resetting ticket/SLA");
  assert.equal(creationReplay.command.replayed,true);assert.equal(creationReplay.authorityFence,advancedTicket.authorityFence);
  assert.equal(creationReplay.slaDeadline,createdTicket.slaDeadline);
  assert.deepEqual(await ticketEffects(createdTicket.id),{intents:2,created:1,notifications:1,audit:1});
  const lostTicketIntent=ticketPacket({subject:`${h.prefix} lost ticket creation reply`});
  const ticketFaultStart=h.responseFaultEvents.length;
  h.loseNextSuccessfulResponse("POST","/api/tickets","truncate");
  await assert.rejects(()=>h.request(ticketRole,"POST","/api/tickets",lostTicketIntent));
  assert.ok(h.responseFaultEvents.slice(ticketFaultStart).some(event=>event.event==="executed"&&event.status===201),"Post-commit ticket reply loss actually executed");
  const recoveredTicket=await check(ticketRole,"POST","/api/tickets",lostTicketIntent,200,"Lost ticket reply replays one local durable creation");
  assert.equal(recoveredTicket.command.replayed,true);
  assert.deepEqual(await ticketEffects(recoveredTicket.id),{intents:1,created:1,notifications:1,audit:1});
  await h.db.update(contacts).set({archivedAt:new Date()}).where(eq(contacts.id,ticketContacts[0].id));
  await check(ticketRole,"POST","/api/tickets",lostTicketIntent,404,"Ticket intent replay rechecks current target authorization");
  await h.db.update(contacts).set({archivedAt:null}).where(eq(contacts.id,ticketContacts[0].id));
  assert.equal(h.externalCalls(),0,"Ticket creation has zero native/provider execution");
  const datedRfi=await check(ticketRole,"POST","/api/rfis",{
    commandId:randomUUID(),expectedActorId:ticketEmployee.id,expectedAccountVersion:ticketEmployee.accountVersion,
    contactId:ticketContacts[0].id,subject:`${h.prefix} precise deadline RFI`,dueDate:"2026-10-09T04:22:33.123Z"},
    201,"Fresh local RFI deadline uses the existing B command owner");
  await h.pool.query("UPDATE rfis SET due_date='2026-10-09 04:22:33.123456+00' WHERE id=$1",[datedRfi.id]);
  const exactDeadline=async()=>(await h.pool.query("SELECT due_date::text AS deadline FROM rfis WHERE id=$1",[datedRfi.id])).rows[0].deadline;
  const originalDeadline=await exactDeadline();
  const datedRead=await check(ticketRole,"GET",`/api/rfis/${datedRfi.id}`,undefined,200,"Authorized RFI DTO read retains a deadline presentation");
  const retainedDeadline=await check(ticketRole,"PUT",`/api/rfis/${datedRfi.id}`,{
    commandId:randomUUID(),expectedActorId:ticketEmployee.id,expectedAccountVersion:ticketEmployee.accountVersion,
    expectedFence:datedRead.authorityFence,subject:`${h.prefix} deadline subject changed`,
    ...workDueDateChange(workDueDay(datedRead.dueDate),datedRead.dueDate)},200,
    "Actual unchanged-day edit omits timestamp and preserves native microseconds");
  assert.equal(await exactDeadline(),originalDeadline);
  await check(ticketRole,"PUT",`/api/rfis/${datedRfi.id}`,{
    commandId:randomUUID(),expectedActorId:ticketEmployee.id,expectedAccountVersion:ticketEmployee.accountVersion,
    expectedFence:retainedDeadline.authorityFence,dueDate:null},200,"Explicit due-day clear is a versioned local edit");
  assert.equal(await exactDeadline(),null);
  const {merchantHealthScores,churnScoreWeights}=await import("../shared/schema");
  const healthContacts=await h.db.insert(contacts).values([
    {firstName:h.prefix,lastName:"Health Own",email:`${h.prefix}-health-own@example.test`,phone:"",recordClass:"production",assignedTo:ticketEmployee.email},
    {firstName:h.prefix,lastName:"Health Foreign",email:`${h.prefix}-health-foreign@example.test`,phone:"",recordClass:"production",assignedTo:h.email("other")},
    {firstName:h.prefix,lastName:"Health Unassigned",email:`${h.prefix}-health-unassigned@example.test`,phone:"",recordClass:"production",assignedTo:null},
    {firstName:h.prefix,lastName:"Health Archived",email:`${h.prefix}-health-archived@example.test`,phone:"",recordClass:"production",assignedTo:ticketEmployee.email,archivedAt:new Date()},
    {firstName:h.prefix,lastName:"Health Test",email:`${h.prefix}-health-test@example.test`,phone:"",recordClass:"test",assignedTo:ticketEmployee.email},
  ]).returning();
  const healthObservations=await h.db.insert(merchantHealthScores).values(healthContacts.map(c=>({
    contactId:c.id,churnScore:80,riskTier:"High",computedAt:new Date("2026-10-01T00:00:00Z"),
  }))).returning();
  await check("merchant","GET","/api/churn-scores",undefined,403,"Merchant cannot mount employee score observations");
  await check("partner","GET","/api/churn-scores/summary",undefined,403,"Partner cannot read employee summary");
  const agentHealth=await check(ticketRole,"GET","/api/churn-scores",undefined,200,"A contact authority scopes production/nonarchived score rows");
  assert.deepEqual(agentHealth.map((r:any)=>r.id),[healthObservations[0].id,healthObservations[2].id]);
  assert.ok(agentHealth.every((r:any)=>r.contact?.id===r.contactId));
  const adminHealth=await check("admin","GET","/api/churn-scores",undefined,200,"Privileged health read still excludes archived/test observations");
  assert.deepEqual(adminHealth.map((r:any)=>r.id),healthObservations.slice(0,3).map(r=>r.id));
  assert.deepEqual(await check(ticketRole,"GET","/api/churn-scores/summary",undefined,200,"Agent summary shares the existing A population boundary"),
    [{tier:"High",count:2}]);
  assert.deepEqual(await check("admin","GET","/api/churn-scores/summary",undefined,200,"Admin summary counts the actual authorized stored score records"),
    [{tier:"High",count:3}]);
  assert.deepEqual(await check(ticketRole,"GET","/api/churn-scores?riskTier=Low",undefined,200,"Server-owned stored-tier selection has truthful empty results"),[]);
  // Private isolated config fixture, never reused by another config case.
  await h.db.delete(churnScoreWeights);
  assert.deepEqual(await check("admin","GET","/api/churn-score-weights",undefined,200,"Empty configuration read is non-mutating, not seeded defaults"),[]);
  assert.deepEqual(await check("admin","GET","/api/churn-score-weights",undefined,200,"Repeated empty config GET has no insertion effects"),[]);
  assert.equal(Number((await h.pool.query("SELECT count(*) FROM churn_score_weights")).rows[0].count),0);
  const {storage:healthStorage}=await import("../server/storage");
  const workerWeights=await healthStorage.getChurnScoreWeights();
  assert.equal(workerWeights.length,6,"Existing internal worker/default owner behavior is preserved");
  const savedWeights=await check("admin","GET","/api/churn-score-weights",undefined,200,"Configured weights read returns stored observations without writes");
  assert.equal(savedWeights.length,6);
  assert.equal(Number((await h.pool.query("SELECT count(*) FROM churn_score_weights")).rows[0].count),6);
  assert.equal(h.externalCalls(),0,"Scoped Health reads and private config fixture have no computation/provider/native execution");
  const canonicalDayTasks=await h.db.insert(tasks).values([
    ...Array.from({length:25},(_,index)=>({
      title:`${h.prefix} My Day canonical ${index}`,contactId:rfiContacts[0].id,assignedTo:h.email("agent"),
      status:"completed",authorityState:index===0?"in_progress":"open",
      dueDate:new Date(index===0?"1899-01-01T00:00:00Z":"1900-01-01T00:00:00Z"),
    })),
    {title:`${h.prefix} My Day excluded completed`,contactId:rfiContacts[0].id,assignedTo:h.email("agent"),
      status:"pending",authorityState:"completed",dueDate:new Date("1800-01-01T00:00:00Z")},
  ]).returning();
  const myDay=await check("agent","GET","/api/my-day",undefined,200,"M10 actual My Day DTO projects effective authority state; 20-row queue is not total");
  assert.equal(myDay.tasksToday.length,20);assert.equal(myDay.taskQueue.returned,20);
  assert.ok(Number(myDay.taskQueue.total)>20);
  assert.equal(myDay.tasksToday.find((row:any)=>row.id===canonicalDayTasks[0].id)?.status,"in_progress");
  assert.equal(myDay.tasksToday.some((row:any)=>row.id===canonicalDayTasks[25].id),false);
  for(const row of myDay.tasksToday)if(canonicalDayTasks.slice(1,25).some(task=>task.id===row.id))assert.equal(row.status,"pending");
  assert.equal(h.externalCalls(),0,"RFI reads and My Day fact projection have zero external effects");
  await mkdir("docs/certification/stage3-c4",{recursive:true});
  await writeFile("docs/certification/stage3-c4/handler-actions.json",JSON.stringify({status:"passed",identity,rows,
    faultEvents:h.responseFaultEvents,preparationFaults,leaderboardFaults,externalAttempts:h.externalCalls(),externalEgress:0,
    qualification:"Actual source handlers and disposable persistence. Delayed native states simulated in ledger; not native worker/serving/all-controls acceptance."},null,2)+"\n");
  console.log(`C4 actual handlers PASS (${rows.length} bounded named HTTP cases plus scoped assertions)`);
} finally {await h.close();}
