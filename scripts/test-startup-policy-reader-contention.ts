/**
 * Authentic policy convergence with a concurrent authority-pinned reader.
 * Private PostgreSQL only; no app server, shared database, Redis or provider.
 */
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {randomBytes} from "node:crypto";
import {userInfo} from "node:os";
import {buildLocalRehearsalEnvironment,launchLocalPostgres16,withLocalClient} from "./local-rehearsal-core";

if (!process.argv.includes("--child")) {
  const cluster=await launchLocalPostgres16();
  try {
    const name="test_startup_policy_readers";
    await withLocalClient(cluster.admin,c=>c.query(`CREATE DATABASE "${name}"`));
    const env=buildLocalRehearsalEnvironment({BACKGROUND_JOB_PROFILE:"off",
      XDG_CONFIG_HOME:process.env.XDG_CONFIG_HOME || "/tmp"});
    env.DATABASE_URL=`postgresql://${encodeURIComponent(userInfo().username)}@localhost/${name}?host=${encodeURIComponent(cluster.socket.realpath)}&port=${cluster.port}`;
    env.TEST_DATABASE_URL=env.DATABASE_URL;
    env.CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString("base64");
    env.MERCHANT_DATA_ENCRYPTION_KEY=randomBytes(32).toString("base64");
    env.AI_INTEGRATIONS_OPENAI_API_KEY="disposable-constructor-only";
    async function run(args:string[]) {
      const rc=await new Promise<number>((resolve,reject)=>{
        const child=spawn("npx",["tsx",...args],{env,stdio:"inherit"});
        child.on("error",reject);child.on("exit",code=>resolve(code ?? 1));
      });
      assert.equal(rc,0,`Isolated command failed: ${args[0]}`);
    }
    await run(["scripts/migrate.ts"]);
    await run(["scripts/test-startup-policy-reader-contention.ts","--child"]);
  } finally {
    await cluster.stop();
    console.log("STARTUP_POLICY_DISPOSABLE_CLUSTER_DESTROYED");
  }
} else {
  assert.equal(process.env.NODE_ENV,"test");
  assert.equal(process.env.VG_PROVIDER_DENY_MODE,"1");
  assert.equal(new URL(process.env.DATABASE_URL!).pathname,"/test_startup_policy_readers");
  const {pool}=await import("../server/db");
  const {SEED_TARGETS}=await import("../server/services/production-seed-convergence");
  const {convergeSfpRecipientPolicyV2}=await import("../server/services/cro03/sfp-recipient-policy-convergence");
  const target=SEED_TARGETS.find(t=>t.id==="sfp_outreach_policy_v1")!;
  const holder=await pool.connect();
  const contender=await pool.connect();
  try {
    await target.write();
    const upgraded=await convergeSfpRecipientPolicyV2();
    assert.equal(upgraded.activated,true,"Known migration policy still upgrades under an exclusive lock");
    const before=await pool.query(`SELECT c.active_policy_id,p.version,p.document_hash
      FROM sfp_outreach_policy_control c JOIN sfp_outreach_policy_documents p ON p.id=c.active_policy_id
      WHERE c.singleton=TRUE`);
    assert.equal(Number(before.rows[0].version),2);
    await holder.query("BEGIN");
    await holder.query(`SELECT c.active_policy_id FROM sfp_outreach_policy_control c
      JOIN sfp_outreach_policy_documents d ON d.id=c.active_policy_id
      WHERE c.singleton=TRUE FOR SHARE OF c,d`);
    await contender.query("BEGIN");
    await contender.query("SET LOCAL lock_timeout='250ms'");
    await assert.rejects(contender.query(`SELECT active_policy_id FROM sfp_outreach_policy_control
      WHERE singleton=TRUE FOR UPDATE`),(error:any)=>error.code==="55P03");
    await contender.query("ROLLBACK");
    const start=performance.now();
    const seeded=await target.write();
    assert.equal(seeded.outcome,"already_present");
    const resumed=await convergeSfpRecipientPolicyV2();
    assert.equal(resumed.activated,false);
    const elapsedMs=Math.round(performance.now()-start);
    assert(elapsedMs<5000,"Both real startup policy checks finish while the original reader still holds its pin");
    const after=await pool.query(`SELECT c.active_policy_id,p.version,p.document_hash
      FROM sfp_outreach_policy_control c JOIN sfp_outreach_policy_documents p ON p.id=c.active_policy_id
      WHERE c.singleton=TRUE`);
    assert.deepEqual(after.rows,before.rows,"No policy selection or immutable document changed");
    await holder.query("ROLLBACK");

    // A writer changing selection between preflight and exclusive acquisition
    // must be observed by the original write-time checks, not upgraded blindly.
    let calls=0,writes=0;
    const raced=await convergeSfpRecipientPolicyV2({transaction:async(fn:any)=>{
      const phase=++calls;
      return fn({execute:async(query:any)=>{
        if(phase===1)return {rows:[{version:1}]};
        // Only the exclusive re-read may run; any ensuing insert is a failure.
        if(++writes>1)throw new Error("UNEXPECTED_POLICY_WRITE");
        return {rows:[{version:3}]};
      }});
    }});
    assert.equal(raced.activated,false);assert.equal(calls,2);assert.equal(writes,1);
    let customQueries=0;
    const custom=await convergeSfpRecipientPolicyV2({transaction:async(fn:any)=>{
      return fn({execute:async()=>{
        customQueries++;
        assert(customQueries<=2,"Custom version-one content cannot produce writes");
        return {rows:[{version:1,document_hash:"custom-policy"}]};
      }});
    }});
    assert.equal(custom.activated,false);assert.equal(custom.reason,"custom_policy_preserved");
    console.log(JSON.stringify({event:"STARTUP_POLICY_READER_CONTENTION_PASS",checks:6,
      authenticReadLockHeld:true,oldExclusiveLockBlocked:true,
      verificationElapsedMs:elapsedMs,selectionUnchanged:true,
      actualUpgradePreserved:true,concurrentSelectionRechecked:true,
      customPolicyPreserved:true,productionWrites:0,providerCalls:0,outboundEffects:0}));
  } finally {
    await holder.query("ROLLBACK").catch(()=>{});
    await contender.query("ROLLBACK").catch(()=>{});
    holder.release();contender.release();
    await pool.end();
  }
}
