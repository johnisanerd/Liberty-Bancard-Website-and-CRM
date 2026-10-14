import assert from "node:assert/strict";
import {createHash,randomBytes} from "node:crypto";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {spawnCertificationTsx,terminateCertificationChild} from "../certification-child-process";
import type {stage3BHttpFixture} from "./stage3-b-http";

/** Runs the actual production server bundles against owned latest-schema data.
 * No migration or worker entry point and no production connection is used. */
export async function runC4BundledRollback(h:Awaited<ReturnType<typeof stage3BHttpFixture>>,identity:any){
  const hash=(data:string|Buffer)=>createHash("sha256").update(data).digest("hex");
  const baseline=path.resolve("../c4-performance-baseline");
  const baselineIdentity=JSON.parse(await readFile(path.join(baseline,"dist/candidate-integrity.json"),"utf8"));
  const wrapper=path.resolve("scripts/fixtures/stage3-c4-bundled-rollback-child.ts");
  const tableNames=["contacts","merchant_mids","deals","documents","merchant_residuals",
    "chargebacks","tasks","tickets","rfis","onboarding_checklist_items","residual_imports",
    "agent_residuals","agent_payouts","partner_commissions","statement_reviews","contact_business_link_decisions",
    "contact_lifecycle_receipts","work_item_command_receipts"];
  const snapshot=async()=>{
    const {rows:existing}=await h.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    const available=new Set(existing.map((r:any)=>r.tablename));
    const tables:Record<string,{count:number;hash:string}>={};
    for(const name of tableNames.filter(name=>available.has(name))){
      const {rows}=await h.pool.query(`SELECT row_to_json(t)::text AS value FROM "${name}" t ORDER BY value`);
      tables[name]={count:rows.length,hash:hash(JSON.stringify(rows))};
    }
    assert.ok(tables.contacts.count>=110&&tables.merchant_mids.count>=110);
    const {rows:schema}=await h.pool.query(`SELECT table_name,column_name,data_type,is_nullable,column_default
      FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position`);
    return {tables,schemaHash:hash(JSON.stringify(schema))};
  };
  const before=await snapshot(),runs:any[]=[];
  for(const version of ["candidate","baseline","candidate"] as const){
    const root=version==="candidate"?process.cwd():baseline;
    const bundle=path.join(root,"dist/index.cjs");
    const expected=(version==="candidate"?identity:baselineIdentity).outputs.find((o:any)=>o.file==="dist/index.cjs");
    assert.ok(expected);assert.equal(hash(await readFile(bundle)),expected.sha256);
    const port=await new Promise<number>((resolve,reject)=>{
      const server=net.createServer();server.on("error",reject);server.listen(0,"127.0.0.1",()=>{
        const address=server.address() as net.AddressInfo;server.close(()=>resolve(address.port));
      });
    });
    const base=`http://127.0.0.1:${port}`;
    const nonce=randomBytes(32).toString("hex");
    const child=spawnCertificationTsx(wrapper,[bundle],{cwd:root,stdio:"pipe",env:{
      PORT:String(port),BASE_URL:base,NODE_ENV:"test",BACKGROUND_JOB_PROFILE:"off",
      CERTIFICATION_HTTP_HOST:"127.0.0.1",CERTIFICATION_HTTP_NONCE:nonce,
    }});
    // Retain no raw server logs: constructors/auth errors can contain secrets.
    let exited=false;child.on("exit",()=>{exited=true;});
    child.stdout?.on("data",()=>{});child.stderr?.on("data",()=>{});
    try{
      let health:any;
      for(let attempt=0;attempt<120&&!exited;attempt++){
        try{
          const response=await h.originalFetch(`${base}/api/health`,{signal:AbortSignal.timeout(1000)});
          if(response.ok){health=await response.json();break;}
        }catch{}
        await new Promise(r=>setTimeout(r,500));
      }
      assert.ok(health,`${version} actual bundled server must become healthy`);
      // The verified production recipe inlines NODE_ENV=production into the
      // business bundle. The separate launcher still verifies the real process
      // environment is test, its infrastructure is disposable and workers off.
      assert.equal(health.env,"production");
      assert.equal(health.certificationHttpNonce,nonce);
      assert.equal(health.certificationHttpListenerAddress,"127.0.0.1");
      assert.equal(health.certificationHttpListenerPort,port);
      assert.equal(health.certificationHttpReusePort,false);
      const response=await h.originalFetch(`${base}/api/portfolio?limit=100`,{
        headers:{Cookie:h.sessions.get("admin")!.cookie},signal:AbortSignal.timeout(10000),
      });
      assert.equal(response.status,200,`${version} uses actual persisted authenticated session`);
      const body=await response.json();
      assert.ok(body,"Native bundled reader returns a nonempty response");
      assert.deepEqual(await snapshot(),before,`${version} forward-compatible source/artifact rollback preserves business data and latest schema`);
      runs.push({version,sourceHead:version==="candidate"?identity.sourceHead:baselineIdentity.sourceHead,
        bundleHash:expected.sha256,health:true,compiledEnvironment:health.env,
        launcherEnvironment:"test",privateListenerVerified:true,
        authenticatedReaderStatus:response.status,dataInvariant:true});
    }finally{await terminateCertificationChild(child);}
  }
  assert.equal(h.externalCalls(),0);
  await mkdir("generated-artifacts/stage3-c4",{recursive:true});
  await writeFile("generated-artifacts/stage3-c4/bundled-rollback.json",JSON.stringify({
    status:"passed",identity,runs,before,after:await snapshot(),
    qualification:"Actual candidate→baseline→candidate production server bundles with inlined production business branches; separately guarded test launcher, owned latest-schema DB/Redis, verified private listener, worker profile off, fatal provider denial; stored business invariants only, no native transmission or production rollback",
  },null,2)+"\n");
}
