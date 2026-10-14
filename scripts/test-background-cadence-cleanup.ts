import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import ts from "typescript";
import {runInNewContext} from "node:vm";

// Inspect the real production configuration without importing the application:
// no DB, Redis, provider, worker, schedule or environment mutation is possible.
const path="server/services/queue-manager.ts";
const current=readFileSync(path,"utf8");
const before=execFileSync("git",["show",`HEAD:${path}`],{encoding:"utf8"});
function array(source:string,name:string):ts.ArrayLiteralExpression {
  const parsed=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);
  for(const statement of parsed.statements) {
    if(!ts.isVariableStatement(statement))continue;
    for(const declaration of statement.declarationList.declarations)
      if(declaration.name.getText(parsed)===name && declaration.initializer
        && ts.isArrayLiteralExpression(declaration.initializer)) return declaration.initializer;
  }
  throw new Error(`Missing configuration array: ${name}`);
}
function configs(source:string) {
  const result=new Map<string,Map<string,string>>();
  for(const entry of array(source,"QUEUE_CONFIGS").elements) {
    assert(ts.isObjectLiteralExpression(entry));
    const properties=new Map<string,string>();
    for(const property of entry.properties) {
      assert(ts.isPropertyAssignment(property));
      properties.set(property.name.getText(),property.initializer.getText());
    }
    const name=properties.get("name")!;
    assert(!result.has(name),`Duplicate physical queue: ${name}`);
    result.set(name,properties);
  }
  return result;
}
const expected=new Map([
  ["QUEUE_NAMES.SUNBIZ_FULL_BACKFILL",5*60_000],
  ["QUEUE_NAMES.FREE_ENRICHMENT_LANE",45*60_000],
  ["QUEUE_NAMES.SFP_FREE_CLASSIFICATION",10*60_000],
  ["QUEUE_NAMES.SFP_CONTINUOUS_DISCOVERY",30*60_000],
]);
const prior=configs(before),after=configs(current);
assert.deepEqual([...after.keys()],[...prior.keys()],"No workers added, removed or reordered");
for(const [name,properties] of after) {
  const old=prior.get(name)!;
  assert.deepEqual([...properties.keys()],[...old.keys()]);
  for(const [key,value] of properties) {
    if(key==="repeatEveryMs" && expected.has(name)) {
      assert(/^[0-9_ *]+$/.test(value),"Changed cadences must be literal durations");
      assert.equal(runInNewContext(value,{}, {timeout:100}),expected.get(name));
    } else {
      assert.equal(value,old.get(key),`${name}.${key} remains unchanged`);
    }
  }
}
assert.equal(expected.size,4);
for(const name of expected.keys())assert(after.has(name));
assert.equal(
  array(current,"NAMED_QUEUE_SCHEDULES").getText(),
  array(before,"NAMED_QUEUE_SCHEDULES").getText(),
  "Event dispatch, recovery/watchdog schedules and qualification outboxes remain unchanged",
);
const oldImport=prior.get("QUEUE_NAMES.CANONICAL_IMPORT_RECOVERY")!;
assert.deepEqual(after.get("QUEUE_NAMES.CANONICAL_IMPORT_RECOVERY"),oldImport,
  "Import recovery's one-minute production wakeup and serial concurrency are protected");
// Configuration changes must not sneak in mutations to the scheduler,
// dispatchers, authority heartbeats, transactions or provider/outbound gates.
const scrub=(source:string)=>{
  const config=array(source,"QUEUE_CONFIGS");
  return (source.slice(0,config.pos)+source.slice(config.end))
    .replace('import { isOwnedRepeatableSchedule } from "./owned-repeatable-schedule";\n',"")
    .replaceAll("isOwnedRepeatableSchedule(job, config.jobName, baseScheduleId)","job.id === baseScheduleId")
    .replaceAll("isOwnedRepeatableSchedule(job, sched.jobName, sched.jobId)","job.id === sched.jobId")
    .replace(
      "// Match the exact descriptor: BullMQ v5 hashes jobId into the key and\n      // omits it from returned metadata; name-only matching is unsafe.",
      "// Remove only the repeatable job(s) whose BullMQ key matches this entry's jobId.\n      // BullMQ encodes the jobId into the repeatable key as part of the key string.",
    )
    .replace("Replaces only the owned base repeatable schedule and re-adds with the new",
      "Removes all existing repeatable jobs for the queue and re-adds with the new");
};
assert.equal((current.match(/isOwnedRepeatableSchedule\(job,/g)??[]).length,3,
  "Startup base/named schedules and interval updates all use exact hashed identity");
assert.equal(scrub(current),scrub(before),
  "Only queue configuration and the exact schedule identity repair changed; dispatchers and safety/authority logic are untouched");
console.log(`PASS: four conservative cadences; ${after.size} existing queues preserved; exact schedule identity repair; all other config, named schedules, import recovery, heartbeats and controls unchanged`);
