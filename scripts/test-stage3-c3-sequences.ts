import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {stage3BHttpFixture} from "./fixtures/stage3-b-http";

// C3 F02 acceptance on a guarded disposable database: the exact DTOs the Sequences page sends, advanced
// step config round trip, partial-create recovery, double submit, stale version, actor change and
// persisted-step omission. Strict schemas and the command owner are exercised unmodified.
const h=await stage3BHttpFixture(async app=>{
  const module=await import("../server/routes/campaigns");
  module.registerCampaignsRoutes(app);
});
try {
  // The create DTO the page sends: name, description, triggerType plus the retained command identity.
  const createFields=(commandId=randomUUID(),role="manager")=>({commandId,expectedActorId:h.userId(role),expectedAccountVersion:1});
  const createCommand=randomUUID();
  const createBody={name:"C3 fixture sequence",description:"fixture",triggerType:"manual",...createFields(createCommand)};
  const created=await h.request("manager","POST","/api/sequences",createBody);
  assert.equal(created.status,201,JSON.stringify(created.body));
  assert.equal(created.body.status,"paused","server owns the initial paused status");
  assert.equal(created.body.totalSteps,0);
  assert.equal(created.body.replayed,false);
  const id=created.body.id as number;

  // Lost response / double click: the same command recovers the committed ID and creates nothing new.
  const replayedCreate=await h.request("manager","POST","/api/sequences",createBody);
  assert.equal(replayedCreate.status,200,JSON.stringify(replayedCreate.body));
  assert.equal(replayedCreate.body.id,id);assert.equal(replayedCreate.body.replayed,true);
  assert.equal((await h.pool.query("SELECT count(*)::int n FROM follow_up_sequences WHERE name='C3 fixture sequence'")).rows[0].n,1,"replay never duplicates");
  // Same command with a different normalized payload conflicts and changes nothing.
  const changed=await h.request("manager","POST","/api/sequences",{...createBody,name:"C3 changed payload"});
  assert.equal(changed.status,409,JSON.stringify(changed.body));
  assert.equal((await h.pool.query("SELECT count(*)::int n FROM follow_up_sequences WHERE name='C3 changed payload'")).rows[0].n,0);
  // The audit row commits with the sequence, exactly once, and the replay wrote no second one.
  assert.equal((await h.pool.query("SELECT count(*)::int n FROM audit_logs WHERE action='sequence_created' AND entity_id=$1",[id])).rows[0].n,1,"audit row is atomic with the create");
  // Missing or malformed command identity, a different signed-in actor and a stale account version are refused.
  const {commandId:_omit,...noCommand}=createBody;
  assert.equal((await h.request("manager","POST","/api/sequences",noCommand)).status,400,"create requires a command ID");
  assert.equal((await h.request("manager","POST","/api/sequences",{...createBody,commandId:"nope"})).status,400);
  const wrongActor=await h.request("manager","POST","/api/sequences",{...createBody,commandId:randomUUID(),expectedActorId:h.userId("admin")});
  assert.ok([409,404].includes(wrongActor.status),`actor mismatch refused (${wrongActor.status})`);
  const wrongAccount=await h.request("manager","POST","/api/sequences",{...createBody,commandId:randomUUID(),expectedAccountVersion:99});
  assert.ok([409,404].includes(wrongAccount.status),`account version mismatch refused (${wrongAccount.status})`);
  assert.equal((await h.pool.query("SELECT count(*)::int n FROM follow_up_sequences WHERE name='C3 fixture sequence'")).rows[0].n,1,"refused creates persist nothing");

  // Server-owned fields are still refused by the strict schemas.
  for(const forbidden of [{status:"active"},{totalSteps:3},{createdBy:"someone"}]) {
    const refused=await h.request("manager","POST","/api/sequences",{name:"C3 forbidden",description:"x",triggerType:"manual",...createFields(),...forbidden});
    assert.equal(refused.status,400,`forbidden ${Object.keys(forbidden)[0]} must be rejected`);
  }
  assert.equal((await h.pool.query("SELECT count(*)::int n FROM follow_up_sequences WHERE name='C3 forbidden'")).rows[0].n,0);

  // Partial create: first step persisted, second not yet. Recovery appends only the missing step.
  const config={abTest:{splitRatio:70,minSampleSize:40},tags:["a","b"],nested:{k:1}};
  const first=await h.request("manager","POST",`/api/sequences/${id}/steps`,{stepOrder:1,actionType:"email",delayDays:0,delayHours:0,subject:"S1",body:"B1",config});
  assert.equal(first.status,201,JSON.stringify(first.body));
  let steps=(await h.request("manager","GET",`/api/sequences/${id}/steps`)).body as any[];
  assert.equal(steps.length,1,"partial create is readable as one persisted step");
  assert.equal((await h.pool.query("SELECT count(*)::int n FROM follow_up_sequences WHERE name='C3 fixture sequence'")).rows[0].n,1,"recovery never duplicates the sequence");
  const second=await h.request("manager","POST",`/api/sequences/${id}/steps`,{stepOrder:2,actionType:"email",delayDays:2,delayHours:0,subject:"S2",body:"B2"});
  assert.equal(second.status,201,JSON.stringify(second.body));
  steps=(await h.request("manager","GET",`/api/sequences/${id}/steps`)).body as any[];
  assert.deepEqual(steps.map(s=>s.stepOrder).sort(),[1,2]);
  assert.equal((await h.pool.query("SELECT total_steps FROM follow_up_sequences WHERE id=$1",[id])).rows[0].total_steps,2,"step count is server-owned");

  const fields=(version:number,role="manager")=>({commandId:randomUUID(),expectedVersion:version,expectedActorId:h.userId(role),expectedAccountVersion:1});
  const editorSteps=(rows:any[])=>rows.map((s,index)=>({id:s.id,stepOrder:index+1,actionType:s.actionType,delayDays:s.delayDays,delayHours:s.delayHours,
    subject:s.subject,body:s.body,config:s.config ?? null,variantBSubject:s.variantBSubject ?? null,variantBBody:s.variantBBody ?? null,abTestConfig:s.abTestConfig ?? null}));
  const version=(await h.pool.query("SELECT version FROM follow_up_sequences WHERE id=$1",[id])).rows[0].version as number;

  // Edit with full typed steps: ids and advanced config survive.
  const editFields=fields(version);
  const edit={...editFields,name:"C3 fixture sequence (edited)",description:"fixture",triggerType:"manual",steps:editorSteps(steps)};
  const saved=await h.request("manager","PUT",`/api/sequences/${id}`,edit);
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  const after=(await h.pool.query("SELECT id,step_order,config FROM sequence_steps WHERE sequence_id=$1 ORDER BY step_order",[id])).rows;
  assert.deepEqual(after.map(r=>r.id),steps.slice().sort((a:any,b:any)=>a.stepOrder-b.stepOrder).map((s:any)=>s.id),"persisted step ids are preserved");
  assert.deepEqual(after[0].config,config,"advanced step config round-trips");

  // Double submit of the same command replays and changes nothing further.
  const replay=await h.request("manager","PUT",`/api/sequences/${id}`,edit);
  assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);
  assert.equal((await h.pool.query("SELECT count(*)::int n FROM sequence_command_receipts WHERE sequence_id=$1",[id])).rows[0].n,2,"one create receipt plus one edit receipt; the replay added none");

  // Stale version is refused; nothing changes.
  const stale=await h.request("manager","PUT",`/api/sequences/${id}`,{...fields(version),name:"stale write",steps:editorSteps(steps)});
  assert.equal(stale.status,409);
  assert.equal((await h.pool.query("SELECT name FROM follow_up_sequences WHERE id=$1",[id])).rows[0].name,"C3 fixture sequence (edited)");

  // Persisted-step omission (the old empty-hydration failure shape) is refused and nothing is cleared.
  const current=(await h.pool.query("SELECT version FROM follow_up_sequences WHERE id=$1",[id])).rows[0].version as number;
  const omitted=await h.request("manager","PUT",`/api/sequences/${id}`,{...fields(current),name:"omit",steps:[]});
  assert.equal(omitted.status,409,"an empty step list must not clear persisted steps");
  assert.equal((await h.pool.query("SELECT count(*)::int n FROM sequence_steps WHERE sequence_id=$1",[id])).rows[0].n,2);
  assert.deepEqual((await h.pool.query("SELECT config FROM sequence_steps WHERE sequence_id=$1 AND step_order=1",[id])).rows[0].config,config);

  // Forbidden update field and actor change.
  const withTotal=await h.request("manager","PUT",`/api/sequences/${id}`,{...fields(current),totalSteps:9,steps:editorSteps(steps)});
  assert.equal(withTotal.status,400,"totalSteps stays forbidden on edit");
  const otherActor=await h.request("manager","PUT",`/api/sequences/${id}`,{...fields(current),expectedActorId:h.userId("admin"),name:"other actor",steps:editorSteps(steps)});
  assert.ok([401,403,404,409].includes(otherActor.status),`actor mismatch refused (${otherActor.status})`);
  assert.equal((await h.pool.query("SELECT name FROM follow_up_sequences WHERE id=$1",[id])).rows[0].name,"C3 fixture sequence (edited)");

  // Sequence stays paused throughout; nothing was enrolled or sent.
  assert.equal((await h.pool.query("SELECT status FROM follow_up_sequences WHERE id=$1",[id])).rows[0].status,"paused");
  assert.equal((await h.pool.query("SELECT count(*)::int n FROM sequence_enrollments WHERE sequence_id=$1",[id])).rows[0].n,0);
  assert.equal(h.externalCalls(),0);
  console.log("STAGE3_C3_SEQUENCES_PASS");
} finally {
  await h.close();
}
