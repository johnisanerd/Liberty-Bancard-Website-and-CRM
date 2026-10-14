import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {Queue} from "bullmq";
import Redis from "ioredis";
import {isOwnedRepeatableSchedule} from "../server/services/owned-repeatable-schedule";
import {launchSfp2060DisposableRedis} from "./sfp2060-disposable-redis";

// Reproduce the observed production keys without any production connection.
for (const [name,id,every,key] of [
  ["tick","sunbiz-full-backfill-repeatable","60000","d225396ef434d1095d3c50bff05e1b51"],
  ["run","free-enrichment-lane-repeatable","900000","7714266b6d2f214d364be9e8a8c71216"],
]) {
  assert(isOwnedRepeatableSchedule({name,every,key},name,id));
  assert(!isOwnedRepeatableSchedule({name,every,key},name,id+"-other"));
}
assert(!isOwnedRepeatableSchedule({name:"tick",key:"custom"},"tick","base"));
assert(!isOwnedRepeatableSchedule({name:"tick",key:"custom",id:"base-other"},"tick","base"));
assert(!isOwnedRepeatableSchedule({name:"other",key:"custom",id:"base"},"tick","base"));
assert(isOwnedRepeatableSchedule({name:"tick",key:"tick:base:::60000",every:"60000"},"tick","base"));
const cron = {name:"recover",pattern:"0 6 * * *",tz:"America/New_York",endDate:1800000000000};
assert(isOwnedRepeatableSchedule({...cron,key:createHash("md5")
  .update("recover:owned:1800000000000:America/New_York:0 6 * * *").digest("hex")},"recover","owned"));

// Native installed BullMQ, private local Redis: no app imports, DB, shared Redis,
// worker, provider or outbound activity. The private process is always destroyed.
const privateRedis=await launchSfp2060DisposableRedis(process.env);
const connection=new Redis(privateRedis.url,{maxRetriesPerRequest:null});
const queue=new Queue("schedule-replacement",{connection,prefix:privateRedis.prefix});
try {
  const baseId="base-repeatable", namedId="base-repeatable-recovery", unrelatedId="other";
  await queue.add("tick",{},{jobId:baseId,repeat:{every:60_000}});
  await queue.add("tick",{},{jobId:baseId,repeat:{every:300_000}});
  await queue.add("tick",{},{jobId:unrelatedId,repeat:{every:60_000}});
  await queue.add("recover",{},{jobId:namedId,repeat:{every:120_000}});
  const retained=await queue.add("retained-record",{original:true},{jobId:"retained",delay:3600_000});
  const before=await queue.getRepeatableJobs();
  assert.equal(before.length,4);
  assert(before.every(job=>!job.id),"Native BullMQ reproduces missing returned id");
  const owned=before.filter(job=>isOwnedRepeatableSchedule(job,"tick",baseId));
  assert.equal(owned.length,2,"Both old and new base cadences recognized exactly");
  for(const job of owned)await queue.removeRepeatableByKey(job.key);
  await queue.add("tick",{},{jobId:baseId,repeat:{every:300_000}});
  const after=await queue.getRepeatableJobs();
  assert.equal(after.length,3,"One base plus unrelated and named schedules remain");
  assert.equal(after.filter(job=>isOwnedRepeatableSchedule(job,"tick",baseId)).length,1);
  for(const job of before.filter(job=>!owned.includes(job)))
    assert(after.some(current=>current.key===job.key),"Unrelated/named key preserved");
  assert.deepEqual((await queue.getJob(retained.id!))?.data,{original:true});
  const named=after.filter(job=>isOwnedRepeatableSchedule(job,"recover",namedId));
  assert.equal(named.length,1);
  await queue.removeRepeatableByKey(named[0].key);
  await queue.add("recover",{},{jobId:namedId,repeat:{every:180_000}});
  const final=await queue.getRepeatableJobs();
  assert.equal(final.length,3);
  assert.equal(final.filter(job=>isOwnedRepeatableSchedule(job,"recover",namedId)).length,1);
  assert(final.some(job=>isOwnedRepeatableSchedule(job,"tick",unrelatedId)));
  assert.deepEqual((await queue.getJob(retained.id!))?.data,{original:true});
  console.log("PASS: native BullMQ missing-id reproduction; exact base/named replacement; unrelated schedules and retained records preserved");
} finally {
  await queue.close();
  connection.disconnect();
  await privateRedis.stop();
}
