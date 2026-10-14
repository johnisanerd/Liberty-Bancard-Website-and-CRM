import {spawn,execFileSync} from "node:child_process";
import {randomUUID,randomBytes} from "node:crypto";
import {createServer} from "node:net";
import path from "node:path";
import {existsSync} from "node:fs";
import {userInfo} from "node:os";
import {buildLocalRehearsalEnvironment,launchLocalPostgres16,withLocalClient} from "./local-rehearsal-core";
import {launchSfp2060DisposableRedis} from "./sfp2060-disposable-redis";
import {migrateRetainedSourceEpoch,verifyRetainedSourceEpochContract} from "./certification/retained-native-epoch";

const input=process.argv[2];
if(!input || !existsSync(input))throw new Error("RETAINED_INPUT_DIRECTORY_REQUIRED");
const cluster=await launchLocalPostgres16();
let redis:Awaited<ReturnType<typeof launchSfp2060DisposableRedis>>|undefined;
const env=buildLocalRehearsalEnvironment({NODE_ENV:"test",VG_PROVIDER_DENY_MODE:"1",
  BACKGROUND_JOB_PROFILE:"off",GHL_TRANSPORT_FAILFAST:"true",EMAIL_TRANSPORT_FAILFAST:"true",
   SMS_TRANSPORT_FAILFAST:"true",CREDENTIAL_ENCRYPTION_KEY:randomBytes(32).toString("base64"),
   MERCHANT_DATA_ENCRYPTION_KEY:randomBytes(32).toString("base64"),RETAINED_INPUT_DIR:input,
  XDG_CONFIG_HOME:process.env.XDG_CONFIG_HOME || "/tmp"});
const build=randomUUID();
Object.assign(env,{SFP_PUBLISH_BUILD_ID:build,SFP_PUBLISH_ARTIFACT_SHA:"e".repeat(40),
  RELEASE_SHA:"e".repeat(40),SFP_PUBLISH_BUILT_AT:new Date().toISOString()});
async function run(args:string[]){
  const code=await new Promise<number>((resolve,reject)=>{
    const child=spawn("npx",["tsx",...args],{env,stdio:"inherit"});
    child.on("error",reject);child.on("exit",code=>resolve(code ?? 1));
  });
  if(code!==0)throw new Error(`RETAINED_CERTIFICATION_FAILED:${args[0]}:${code}`);
}
function point(database:string){
  const url=`postgresql://${encodeURIComponent(userInfo().username)}@localhost/${database}?host=${encodeURIComponent(cluster.socket.realpath)}&port=${cluster.port}`;
  env.DATABASE_URL=url;env.TEST_DATABASE_URL=url;
}
try {
  redis=await launchSfp2060DisposableRedis(env);
  Object.assign(env,{REDIS_URL:redis.url,REDIS_PREFIX:redis.prefix,TEST_REDIS_PREFIX:redis.prefix});
  await withLocalClient(cluster.admin,client=>client.query('CREATE DATABASE "test_retained_template"'));
  point("test_retained_template");
  if(process.argv.includes("--native-topology-only")||process.argv.includes("--native-upload-restart-only")){
    await migrateRetainedSourceEpoch(env);
    await verifyRetainedSourceEpochContract(env);
  }else await run(["scripts/migrate.ts"]);
   if(process.argv.includes("--intake-review-only")){
     await run(["scripts/certification/test-intake-review-pages.ts"]);
    } else if(process.argv.includes("--intake-geography-only")){
      await run(["scripts/test-sfp-free-continuation-certification.ts"]);
   } else if(process.argv.includes("--intake-workbooks-only")){
     await run(["scripts/certification/test-canonical-workbook-intake.ts"]);
   } else if(process.argv.includes("--intake-native-contract-only")){
     await run(["scripts/certification/test-intake-native-contract.ts"]);
   } else if(process.argv.includes("--blank-email-only")){
     await run(["scripts/certification/test-contact-blank-email-correction.ts"]);
   } else if(process.argv.includes("--mailbox-identity-only")){
     await run(["scripts/certification/test-contact-mailbox-identity.ts"]);
   } else if(process.argv.includes("--transaction-leases-only")){
     env.DB_POOL_MAX="1";
     await run(["scripts/certification/test-canonical-transaction-leases.ts"]);
   } else if(process.argv.includes("--intake-only")||process.argv.includes("--linker-performance-only")){
     const scripts=process.argv.includes("--linker-performance-only")?[
       "test-contact-business-evidence-candidates.ts",
       "test-source-family-business-materialization.ts",
       "test-crm-contact-link-automation.ts",
       "test-source-only-link-reconsideration.ts",
     ]:[
       "test-intake-native-contract.ts","test-organization-resolver-disposable.ts",
       "test-intake-execution-isolation.ts","test-source-only-link-reconsideration.ts",
       "test-source-family-business-materialization.ts","test-crm-contact-link-automation.ts",
       "test-intake-review-pages.ts","test-contact-blank-email-correction.ts","test-contact-mailbox-identity.ts",
     ];
     for(const [index,script] of scripts.entries()){
       const database=`test_intake_${index}`;
       await withLocalClient(cluster.admin,client=>client.query(
         `CREATE DATABASE "${database}" TEMPLATE "test_retained_template"`));
       point(database);
       await run([`scripts/certification/${script}`]);
     }
      const database="test_intake_geography";
      await withLocalClient(cluster.admin,client=>client.query(
        `CREATE DATABASE "${database}" TEMPLATE "test_retained_template"`));
      point(database);
      await run(["scripts/test-sfp-free-continuation-certification.ts"]);
   } else if(process.argv.includes("--organization-only")){
     await run(["scripts/certification/test-organization-resolver-disposable.ts"]);
   } else if(process.argv.includes("--configured-release-only")){
    await withLocalClient(cluster.admin,client=>client.query(
      'CREATE DATABASE "test_sfp2060_retained_release" TEMPLATE "test_retained_template"'));
    point("test_sfp2060_retained_release");
    const port=await new Promise<number>((resolve,reject)=>{
      const server=createServer();server.once("error",reject);
      server.listen(0,"127.0.0.1",()=>{const address=server.address();
        if(!address || typeof address==="string")return reject(new Error("PRIVATE_CERTIFICATION_PORT_REQUIRED"));
        server.close(()=>resolve(address.port));});
    });
    const workdirIndex=process.argv.indexOf("--release-workdir");
    const cwd=workdirIndex>=0 ? path.resolve(process.argv[workdirIndex+1]) : process.cwd();
    const sha=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8",cwd}).trim();
    Object.assign(env,{PORT:String(port),BASE_URL:`http://127.0.0.1:${port}`,TEST_BASE_URL:`http://127.0.0.1:${port}`,
      CERTIFICATION_HTTP_HOST:"127.0.0.1",CERTIFICATION_HTTP_NONCE:randomBytes(32).toString("hex"),
      SESSION_SECRET:randomBytes(32).toString("hex"),ADMIN_SEED_EMAIL:"admin@retained.test",
      ADMIN_SEED_PASSWORD:randomBytes(32).toString("hex"),AI_INTEGRATIONS_OPENAI_API_KEY:"disposable-constructor-only",
      OPENAI_API_KEY:"disposable-constructor-only",RELEASE_SHA:sha,SFP_PUBLISH_ARTIFACT_SHA:sha});
    const code=await new Promise<number>((resolve,reject)=>{
      const child=spawn("bash",["-c",'RELEASE_SHA=$(git rev-parse HEAD) bash scripts/run-pre-deploy.sh'],
        {env,stdio:"inherit",cwd});child.once("error",reject);child.once("exit",code=>resolve(code ?? 1));
    });
    if(code!==0)throw new Error(`CONFIGURED_RELEASE_CHECK_FAILED:${code}`);
  } else if(process.argv.includes("--native-topology-only")||process.argv.includes("--native-upload-restart-only")) {
    await withLocalClient(cluster.admin,client=>client.query(
      'CREATE DATABASE "test_retained_native_topology" TEMPLATE "test_retained_template"'));
    point("test_retained_native_topology");
    const phases=process.argv.includes("--native-upload-restart-only")
      ? ["seed","upload_interrupt","upload_restart"] : ["seed","recover","replay"];
    for(const phase of phases) {
      console.log(`RETAINED_NATIVE_CERTIFICATION_PHASE ${phase}`);
      if(phase==="recover"||phase==="upload_interrupt")await run(["scripts/migrate.ts"]);
      await run(["scripts/certification/test-retained-canonical-import-recovery.ts",phase]);
    }
  } else if(process.argv.includes("--recovery-faults-only")) {
    await withLocalClient(cluster.admin,client=>client.query(
      'CREATE DATABASE "test_retained_faults" TEMPLATE "test_retained_template"'));
    point("test_retained_faults");
    for(const phase of ["faults","restart","legacy","budget"]){
      console.log(`RETAINED_CERTIFICATION_PHASE ${phase}`);
      await run(["scripts/certification/test-retained-canonical-import-recovery.ts",phase]);
    }
  } else if(process.argv.includes("--recovery-fixture-only")) {
    await withLocalClient(cluster.admin,client=>client.query(
      'CREATE DATABASE "test_retained_provider_recovery" TEMPLATE "test_retained_template"'));
    point("test_retained_provider_recovery");
    await run(["scripts/certification/prepare-provider-import-recovery-input.ts"]);
    await run(["scripts/certification/test-provider-import-recovery.ts"]);
  } else {
  for(const [database,script] of [
    ["test_retained_audited","scripts/certification/test-audited-retained-import-recovery.ts"],
    ["test_retained_original_identity","scripts/certification/test-audited-retained-import-recovery.ts"],
    ["test_retained_provider","scripts/certification/test-canonical-provider-import.ts"],
    ["test_retained_retry","scripts/test-canonical-transaction-retry.ts"],
  ]) {
    if(process.argv.includes("--audited-only") && database!=="test_retained_audited")continue;
    if(process.argv.includes("--identity-only") &&
      !["test_retained_audited","test_retained_original_identity"].includes(database))continue;
    await withLocalClient(cluster.admin,client=>client.query(`CREATE DATABASE "${database}" TEMPLATE "test_retained_template"`));
    point(database);await run([script,...(database==="test_retained_original_identity" ? ["private"]
      : database==="test_retained_audited" ? ["--native-fixture-child"] : [])]);
  }
  if(process.argv.includes("--audited-only") || process.argv.includes("--identity-only")) {
    console.log("AUDITED_FOCUSED_CERTIFICATION_PASS");
  } else {
  for(const [database,script] of [
    ["test_retained_publish","scripts/test-sfp-publish-handoff-disposable.ts"],
    ["test_retained_workbook","scripts/certification/test-canonical-workbook-intake.ts"],
    ["test_retained_leases","scripts/certification/test-canonical-transaction-leases.ts"],
  ]){
    if(process.argv.includes("--core-only"))continue;
    if(process.argv.includes("--skip-workbooks") && database==="test_retained_workbook")continue;
    await withLocalClient(cluster.admin,client=>client.query(`CREATE DATABASE "${database}" TEMPLATE "test_retained_template"`));
    point(database);
    if(database==="test_retained_leases")env.DB_POOL_MAX="1";
    await run([script]);
    delete env.DB_POOL_MAX;
  }
  await withLocalClient(cluster.admin,client=>client.query('CREATE DATABASE "test_retained_workload" TEMPLATE "test_retained_template"'));
  point("test_retained_workload");
  for(const phase of ["faults","restart","legacy","budget"]){
    console.log(`RETAINED_CERTIFICATION_PHASE ${phase}`);
    await run(["scripts/certification/test-retained-canonical-import-recovery.ts",phase]);
  }
  // Historical native data cannot be inserted under a newer source contract.
  // The full runner uses the same verified source-era chronology as its
  // focused native mode, then performs only normal forward migrations.
  await withLocalClient(cluster.admin,client=>client.query('CREATE DATABASE "test_retained_source_epoch"'));
  point("test_retained_source_epoch");
  await migrateRetainedSourceEpoch(env);
  await verifyRetainedSourceEpochContract(env);
  for(const phase of ["seed","recover","replay","upload_interrupt","upload_restart"]){
    console.log(`RETAINED_NATIVE_CERTIFICATION_PHASE ${phase}`);
    if(phase==="recover")await run(["scripts/migrate.ts"]);
    await run(["scripts/certification/test-retained-canonical-import-recovery.ts",phase]);
  }
  console.log("RETAINED_CANONICAL_IMPORT_CERTIFICATION_PASS");
  }
  }
}finally{
  await redis?.stop();
  await cluster.stop();
  console.log("RETAINED_DISPOSABLE_CLUSTER_DESTROYED");
}
