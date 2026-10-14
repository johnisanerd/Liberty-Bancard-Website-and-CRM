import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir,userInfo} from "node:os";
import {join} from "node:path";
import net from "node:net";
import pg from "pg";
import {randomUUID} from "node:crypto";
import {assertDisposableTestInfrastructure} from "./test-infrastructure-guard";
import {observeTransactionConnections,withTransactionPhase} from "../server/lib/transaction-observability";
import {runWithDbContext} from "../server/lib/db-context";
import {fingerprintQuery,readLockTrace,tagLockTrace,safeDatabaseFailure,observeRecoveryFailure} from "../server/lib/lock-trace";
import {PrimaryLockCapture,PRIMARY_LOCK_SNAPSHOT_SQL,sanitizeLockSnapshot} from "../server/services/primary-lock-capture";

// This test owns its entire local cluster; it never connects to the configured
// app database/Redis, imports application workers, or calls a provider.
const root=mkdtempSync(join(tmpdir(),"test-import-lock-"));
const socket=net.createServer();
await new Promise<void>(resolve=>socket.listen(0,"127.0.0.1",resolve));
const port=(socket.address() as net.AddressInfo).port;
await new Promise<void>(resolve=>socket.close(()=>resolve()));
const url=`postgresql://${userInfo().username}@127.0.0.1:${port}/test_import_lock`;
let started=false;
let pool:pg.Pool|undefined;
let stop:()=>void=()=>{};
let checks=0;
const check=(value:unknown,message:string)=>{assert(value,message);checks++;};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const events:Record<string,any>[]=[];
const query1="SELECT id FROM sfp_runtime_owner_authority WHERE id=1 FOR UPDATE";
const query2="SELECT id FROM sfp_runtime_owner_authority WHERE id=2 FOR UPDATE";
try {
  execFileSync("initdb",["-D",join(root,"data"),"-A","trust","--no-locale"],{stdio:"pipe"});
  execFileSync("pg_ctl",["-D",join(root,"data"),"-l",join(root,"postgres.log"),"-o",
    `-h 127.0.0.1 -p ${port} -k ${root} -F`,"-w","start"],{stdio:"pipe"});
  started=true;
  const admin=new pg.Client({connectionString:url.replace("/test_import_lock","/postgres")});
  await admin.connect();await admin.query("CREATE DATABASE test_import_lock");await admin.end();
  await assertDisposableTestInfrastructure({operation:"primary blocker capture certification",
    env:{...process.env,NODE_ENV:"test",DATABASE_URL:url,TEST_DATABASE_URL:url}});
  pool=new pg.Pool({connectionString:url,max:3});
  stop=observeTransactionConnections(pool,{tagSql:true,emit:event=>events.push(event),slowMs:1,sampleMs:20});
  await pool.query("CREATE TABLE sfp_runtime_owner_authority(id integer PRIMARY KEY)");
  await pool.query("INSERT INTO sfp_runtime_owner_authority VALUES(1),(2)");
  const upstream=await runWithDbContext({correlationId:"fixture-upstream",normalizedRoute:"BullMQ sfp-free-classification"},
    ()=>pool!.connect());
  const middle=await runWithDbContext({correlationId:"fixture-middle",normalizedRoute:"BullMQ sfp-continuous-discovery"},
    ()=>pool!.connect());
  const waiter=await runWithDbContext({correlationId:"fixture-waiter",normalizedRoute:"BullMQ canonical-import-recovery"},
    ()=>pool!.connect());
  const nativePid=(await waiter.query("SELECT pg_backend_pid() pid")).rows[0].pid;
  const protocolPid=(waiter as any).processID;
  (waiter as any).processID=-999; // Model the production proxy's non-native identifier.
  await withTransactionPhase("classification",()=>upstream.query("BEGIN"));
  await upstream.query(query1);
  await withTransactionPhase("discovery",()=>middle.query("BEGIN"));
  await middle.query(query2);
  const middleWait=withTransactionPhase("discovery",()=>middle.query(query1));
  const middleHandled=middleWait.catch(error=>{throw error;});
  await withTransactionPhase("import_materialize",()=>waiter.query("BEGIN"));
  const waiterWait=withTransactionPhase("import_materialize",()=>waiter.query(query2));
  const waiterHandled=waiterWait.catch(error=>{throw error;});
  let observer:pg.Client|undefined;
  const captureEvents:Record<string,any>[]=[];
  const capture=new PrimaryLockCapture({durationMs:600,intervalMs:20,emit:event=>captureEvents.push(event),
    createClient:()=>{
      observer=new pg.Client({connectionString:url,
        options:"-c default_transaction_read_only=on -c statement_timeout=750"});
      return observer;
    }});
   capture.start({runtimeDiagnostics:true});const id=capture.status().captureId;
  check(capture.start().captureId===id,"Overlapping starts reuse one observer, not parallel captures");
  await capture.finished();
  const snapshots=captureEvents.filter(event=>event.event==="db:primary_lock_snapshot");
  check(capture.status().state==="completed" && snapshots.length>0,"Real primary contention is captured in a bounded window");
   const runtime=capture.status().runtime!;
   check(runtime.elapsedMs>=600 && runtime.elapsedMs<1600,
     "Opt-in runtime sampling and cleanup stay inside a measured bounded window");
   check(runtime.cpuUserMs+runtime.cpuSystemMs<500 && runtime.maxRoundTripMs>=0,
     "Measured process CPU including observer overhead remains bounded in isolated contention");
   check(Object.values(runtime).every(value=>Number.isFinite(value) && value>=0),
     "Runtime diagnostics contain finite numeric CPU, round-trip and scheduling measurements only");
   console.log(JSON.stringify({event:"primary_runtime_observer_measurement",runtime}));
  const backends=snapshots.flatMap(snapshot=>snapshot.backends);
  const observedWaiter=backends.find(backend=>backend.backendPid===nativePid && backend.trace?.phase==="import_materialize");
  check(observedWaiter?.trace?.worker==="BullMQ canonical-import-recovery",
    "Native primary PID maps to the real worker/phase/checkout despite a negative protocol PID");
   check(observedWaiter.trace.instanceId===capture.status().runtimeProcessInstanceId,
     "Process CPU/scheduling metrics bind to the SQL-tagged process, not an assumed blocker process");
  check(observedWaiter.queryHash===fingerprintQuery(query2),"Trace comments preserve stable SQL fingerprints");
  check(observedWaiter.blockingPids.length>0 && observedWaiter.locks.some((lock:any)=>!lock.granted),
    "Snapshot includes actual blocking PIDs and ungranted native locks");
  const observedMiddle=backends.find(backend=>observedWaiter.blockingPids.includes(backend.backendPid));
  check(observedMiddle?.blockingPids.length>0 && backends.some(backend=>
    observedMiddle.blockingPids.includes(backend.backendPid) && backend.trace?.worker==="BullMQ sfp-free-classification"),
    "Recursive capture follows waiter -> intermediate blocker -> root owner");
  check(!JSON.stringify(captureEvents).includes(query1) && !JSON.stringify(captureEvents).includes("postgresql://"),
    "Snapshot output contains no SQL bodies or connection strings");
  check(pool.options.max===3 && pool.totalCount===3,"Observer does not acquire an application pool slot");
  await upstream.query("ROLLBACK");await middleHandled;
  await middle.query("ROLLBACK");await waiterHandled;await waiter.query("ROLLBACK");
  (waiter as any).processID=protocolPid;
  upstream.release();middle.release();waiter.release();
  const callbackClient=await pool.connect();
  await new Promise<void>((resolve,reject)=>callbackClient.query("BEGIN",error=>error?reject(error):resolve()));
  await new Promise<void>((resolve,reject)=>callbackClient.query("SELECT $1::text value",["private-source@example.test"],
    (error,result)=>{if(error)return reject(error);assert.equal(result.rows[0].value,"private-source@example.test");resolve();}));
  const named={name:"lock_capture_named",text:"SELECT $1::integer AS n",values:[7]};
  await callbackClient.query(named);
  await callbackClient.query("COMMIT");
  callbackClient.release();
  const recycled=await pool.connect();await recycled.query("BEGIN");
  assert.equal((await recycled.query({...named,values:[9]})).rows[0].n,9);checks++;
  await recycled.query("ROLLBACK");recycled.release();
  check(named.text==="SELECT $1::integer AS n","Named prepared SQL and caller configs are unchanged across checkouts");
  check(!JSON.stringify(events).includes("private-source@example.test"),"Query tracing does not emit parameters");

  const failureEvents:Record<string,any>[]=[];
  const original=Object.assign(new Error("wrapper private-source@example.test"),{
    canonicalTransactionPhase:"import_materialize",
    cause:Object.assign(new Error("statement with private-source@example.test"),{code:"55P03"})});
  const cleanup=Object.assign(new Error("cleanup private-source@example.test"),{code:"40P01",
    detail:"Process 11 waits for ShareLock on transaction 99; blocked by process 22.\nProcess 22: SELECT 'private-source@example.test'"});
  const coordinates={executionId:randomUUID(),itemId:randomUUID(),sourceRowNumber:1};
  await assert.rejects(observeRecoveryFailure(original,async()=>{throw cleanup;},coordinates,event=>failureEvents.push(event)),
    error=>error===cleanup);checks++;
  check(failureEvents.length===2 && failureEvents[0].failureId===failureEvents[1].failureId,
    "Original and secondary cleanup errors are logged separately with one correlation ID");
  check(failureEvents[0].failure.causes[1].sqlState==="55P03"
    && failureEvents[1].failure.causes[0].deadlockEdges[0].blockerPid===22,
    "Nested original SQLSTATE and sanitized deadlock edges survive masking");
  check(!JSON.stringify(failureEvents).includes("private-source@example.test"),"Raw errors and PostgreSQL detail statements are excluded");
  const callbackFailure=Object.assign(new Error("private-source@example.test"),{code:"25P03"});
  const rollbackFailure=Object.assign(new Error("private-source@example.test"),{code:"ECONNRESET"});
  const combined=new Error("CANONICAL_TRANSACTION_CALLBACK_AND_CLEANUP_FAILED",
    {cause:{originalError:callbackFailure,cleanupError:rollbackFailure}});
  const combinedSafe=safeDatabaseFailure(new Error("CANONICAL_IMPORT_RECOVERY_ABORTED",{cause:combined}));
  check(combinedSafe.causes.some(c=>c.sqlState==="25P03")
    && combinedSafe.causes.some(c=>c.transportCode==="ECONNRESET"),
    "Combined callback and rollback failures both retain safe diagnosis");
  check(!JSON.stringify(combinedSafe).includes("private-source@example.test"),
    "Branched exception diagnostics never emit raw callback or rollback messages");
  check(safeDatabaseFailure(new Error("PROVIDER_IMPORT_IDENTITY_BRIDGE_NATIVE_GUARD_MISSING"))
    .causes[0].reasonCode==="PROVIDER_IMPORT_IDENTITY_BRIDGE_NATIVE_GUARD_MISSING",
    "Exact identity-bridge capability failures remain actionable");
  const cyclic:any={};cyclic.cause=cyclic;cyclic.originalError=cyclic;
  check(safeDatabaseFailure(cyclic).causes.length===1,
    "Repeated and cyclic exception branches are visited once");
  let deep:any=callbackFailure;
  for(let depth=0;depth<20;depth++)deep={cause:deep,originalError:deep,cleanupError:deep};
  check(safeDatabaseFailure(deep).causes.length===5,
    "Exception traversal retains the depth bound despite branching");
  await assert.rejects(observeRecoveryFailure(original,async()=>{},coordinates,()=>{throw new Error("telemetry unavailable");}),
    error=>error===original);checks++;
  check(true,"Telemetry failures cannot change original throw semantics");

  let replicaSnapshots=0,replicaClosed=0;
  const replica=new PrimaryLockCapture({durationMs:100,intervalMs:10,emit:()=>{},createClient:()=>({
    connect:async()=>{},on:()=>{},end:async()=>{replicaClosed++;},
    query:async text=>{if(text===PRIMARY_LOCK_SNAPSHOT_SQL)replicaSnapshots++;return {rows:[{is_replica:true}]};},
  })});
  replica.start();await replica.finished();
   check(replica.status().runtime===null,"Runtime instrumentation is disabled unless explicitly selected");
  check(replica.status().state==="refused_replica" && replicaSnapshots===0 && replicaClosed===1,
    "Replica connections are explicitly refused, not mislabeled as primary evidence");
  let permissionClosed=0;
  const denied=new PrimaryLockCapture({durationMs:100,intervalMs:10,emit:()=>{},createClient:()=>({
    connect:async()=>{},on:()=>{},end:async()=>{permissionClosed++;},
    query:async text=>{if(text===PRIMARY_LOCK_SNAPSHOT_SQL)
      throw Object.assign(new Error("private-source@example.test"),{code:"42501"});return {rows:[{is_replica:false}]};},
  })});
  denied.start({runtimeDiagnostics:true});await denied.finished();
  check(denied.status().runtime?.observationSamples===0 && denied.status().state==="failed",
    "Failed opt-in observations report zero acquired samples, not a successful no-blocker result");
  check(denied.status().state==="failed" && denied.status().failure?.causes[0].sqlState==="42501" && permissionClosed===1,
    "Unavailable primary permissions are reported truthfully and the observer closes");
  const suspicious=JSON.stringify(sanitizeLockSnapshot([{pid:1,query:"SELECT 'private-source@example.test'",
    locks:[{locktype:"private-source@example.test",mode:"private-source@example.test"}]}]));
  check(!suspicious.includes("private-source"),"Sanitization excludes arbitrary query/lock metadata text");
  const tagged=tagLockTrace("SELECT 1",randomUUID(),"not a worker private-source@example.test","private-source@example.test");
  check(readLockTrace(tagged)?.worker===null && readLockTrace(tagged)?.phase===null,"Trace labels reject uncontrolled context");
  check(safeDatabaseFailure("private-source@example.test").causes.length===0,"Primitive errors cannot leak source text");
  console.log(`Import lock capture PASS (${checks} checks; native PostgreSQL three-transaction blocker chain, proxy PID mismatch, privacy, overloads, replica refusal and separate failure evidence).`);
} finally {
  stop();if(pool)await pool.end();
  if(started)execFileSync("pg_ctl",["-D",join(root,"data"),"-m","immediate","-w","stop"],{stdio:"pipe"});
  rmSync(root,{recursive:true,force:true});
}
