import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {stage3BHttpFixture} from "./fixtures/stage3-b-http";

// C3 R3 on a guarded disposable database and private Redis: the backlog "process" command against a real BullMQ queue
// (producer only: no worker, no provider, no fleet). Proves job-ID validity, durable intent replay, payload/actor
// conflicts, unknown-outcome reconciliation, response loss, and the bounds the worker applies.
const h=await stage3BHttpFixture(async app=>{
  const module=await import("../server/routes/canonical-enrichment");
  module.registerCanonicalEnrichmentRoutes(app);
});
const {Queue}=await import("bullmq");
const {default:Redis}=await import("ioredis");
const run=await import("../server/services/canonical-enrichment-backlog-run");
const {BACKLOG_PROCESS_LIMITS}=await import("../shared/canonical-enrichment-backlog");
const connection=new Redis(process.env.REDIS_URL!,{maxRetriesPerRequest:null});
const prefix=`${process.env.TEST_REDIS_PREFIX}backlog_${randomUUID().replaceAll("-","")}_`;
const queue=new Queue("sfp-continuous-discovery-fixture",{connection,prefix});
try {
  const actor=h.userId("admin"), other=h.userId("manager");
  const request={scope:"local_only" as const,maxRows:500,timeBudgetSeconds:120};

  // Installed BullMQ validator: the old validation wake ID is rejected, the repository ID is accepted.
  await assert.rejects(()=>queue.add("tick",{},{jobId:"canonical-backlog-validation:123"}),/Custom Id cannot contain :/);
  const wake=await queue.add("tick",{},{jobId:run.backlogValidationWakeJobId()});
  assert.equal(wake.id,run.backlogValidationWakeJobId());
  // Clock boundary: the ten-minute window flips exactly at the boundary and stays a valid ID on both sides.
  const edge=600_000*7;
  assert.notEqual(run.backlogValidationWakeJobId(edge-1),run.backlogValidationWakeJobId(edge));
  assert.equal(run.backlogValidationWakeJobId(edge),run.backlogValidationWakeJobId(edge+599_999));
  for(const at of [edge-1,edge,edge+599_999])assert.ok((await queue.add("tick",{},{jobId:run.backlogValidationWakeJobId(at)})).id);

  // Accepted: real add and readback of the exact payload.
  const first=randomUUID();
  const queued=await run.enqueueBacklogProcess(request,first,actor,queue as any);
  assert.equal(queued.outcome,"queued");assert.equal(queued.alreadyQueued,false);
  const job=await queue.getJob(queued.jobId!);
  assert.deepEqual(job?.data,{priorityRequest:request},"queue readback carries the exact bounded request");
  assert.equal(run.backlogPriorityJobId(first),queued.jobId);

  // Duplicate (double click / replay): not queued twice, even across a clock-bucket boundary.
  const again=await run.enqueueBacklogProcess(request,first,actor,queue as any);
  assert.equal(again.outcome,"already_queued");assert.equal(again.alreadyQueued,true);
  assert.equal((await queue.getJobs(["waiting","delayed","active","completed"])).filter(j=>j.id===queued.jobId).length,1);

  // Same intent with a changed payload or a different actor conflicts and queues nothing new.
  await assert.rejects(()=>run.enqueueBacklogProcess({...request,maxRows:600},first,actor,queue as any),run.BacklogIntentConflictError);
  await assert.rejects(()=>run.enqueueBacklogProcess(request,first,other,queue as any),run.BacklogIntentConflictError);
  assert.deepEqual((await queue.getJob(queued.jobId!))?.data,{priorityRequest:request},"conflicting replay never mutates the queued job");

  // Response loss after a committed add and a removed completed job: the durable marker still answers already_queued.
  await (await queue.getJob(queued.jobId!))!.remove();
  const lost=await run.enqueueBacklogProcess(request,first,actor,queue as any);
  assert.equal(lost.outcome,"already_queued");
  assert.equal(await queue.getJob(queued.jobId!),undefined,"a recognized replay does not re-add a finished request");

  // Throw before the add: unknown to the caller, nothing queued, replay of the same command queues exactly once.
  const preAdd=randomUUID();
  const failingBefore={getJob:(id:string)=>queue.getJob(id),add:async()=>{throw new Error("redis down before add");}};
  await assert.rejects(()=>run.enqueueBacklogProcess(request,preAdd,actor,failingBefore as any),/redis down before add/);
  assert.equal(await queue.getJob(run.backlogPriorityJobId(preAdd)),undefined);
  const recovered=await run.enqueueBacklogProcess(request,preAdd,actor,queue as any);
  assert.equal(recovered.outcome,"queued");

  // Add succeeded, then the caller saw a failure: replay reconciles to already_queued with one job.
  const afterAdd=randomUUID();
  const failingAfter={getJob:(id:string)=>queue.getJob(id),add:async(n:string,d:unknown,o:any)=>{await queue.add(n,d as any,o);throw new Error("connection reset after add");}};
  await assert.rejects(()=>run.enqueueBacklogProcess(request,afterAdd,actor,failingAfter as any),/connection reset after add/);
  assert.ok(await queue.getJob(run.backlogPriorityJobId(afterAdd)),"the add committed");
  const reconciled=await run.enqueueBacklogProcess(request,afterAdd,actor,queue as any);
  assert.equal(reconciled.outcome,"already_queued");

  // No queue in this process: nothing claimed, nothing queued.
  const none=randomUUID();
  const unavailable=await run.enqueueBacklogProcess(request,none,actor,null);
  assert.equal(unavailable.outcome,"unavailable");assert.equal(unavailable.accepted,false);
  assert.equal((await h.pool.query("SELECT count(*)::int n FROM system_settings WHERE key=$1",[`canonical_backlog_priority_intent:${none}`])).rows[0].n,0);

  // Worker bounds follow the request exactly; scheduled ticks keep defaults and one preparation pass.
  const bounds=run.backlogPassBounds({scope:"local_only",maxRows:100,timeBudgetSeconds:60});
  assert.deepEqual(bounds.stagedDrain,{timeBudgetMs:60_000,maxRows:100});
  assert.equal(bounds.preparationDeadlineMs,60_000);
  assert.deepEqual(run.backlogPassBounds({scope:"local_only",maxRows:5000,timeBudgetSeconds:600}).stagedDrain,{timeBudgetMs:600_000,maxRows:5000});
  assert.deepEqual(run.backlogPassBounds(null),{stagedDrain:{timeBudgetMs:300_000,maxRows:2000},preparationDeadlineMs:0,maxPreparationPasses:1});
  assert.equal(run.parseBacklogProcessRequest({scope:"local_only",maxRows:BACKLOG_PROCESS_LIMITS.maxRows.max+1}),null,"malformed job data never widens limits");

  // HTTP surface: strict command ID, admin only, and a truthful unavailable state (no producer queue in this process).
  const body={scope:"local_only",maxRows:500,timeBudgetSeconds:120};
  assert.equal((await h.request("admin","POST","/api/canonical-enrichment/backlog/process",body)).status,400,"missing commandId is rejected");
  assert.equal((await h.request("admin","POST","/api/canonical-enrichment/backlog/process",{...body,commandId:"not-a-uuid"})).status,400);
  assert.equal((await h.request("manager","POST","/api/canonical-enrichment/backlog/process",{...body,commandId:randomUUID()})).status,403);
  const http=await h.request("admin","POST","/api/canonical-enrichment/backlog/process",{...body,commandId:randomUUID()});
  assert.equal(http.status,503);assert.equal(http.body.code,"QUEUE_UNAVAILABLE");assert.equal(http.body.accepted,false);
  assert.equal(h.externalCalls(),0);
  console.log("STAGE3_C3_BACKLOG_COMMAND_PASS");
} finally {
  await queue.obliterate({force:true}).catch(()=>undefined);
  await queue.close();
  connection.disconnect();
  await h.close();
}
