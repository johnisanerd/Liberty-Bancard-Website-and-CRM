import assert from "node:assert/strict";
import {cpSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import pg from "pg";
import {assertDisposableTestInfrastructure} from "../test-infrastructure-guard";

/**
 * A historical graph is restored under its real source-era native contract,
 * then upgraded forward through the normal journal. Never replace guards in
 * an already migrated database or teach the corrected verifier old hashes.
 * These source-era hashes were independently read from production on 2026-10-12.
 */
export const retainedSourceNativeBodies={
  crm_automatic_relationship_reasons:"6868a6d639a3fd0af7a10346821dad19",
  enforce_reviewed_contact_business_link:"4b362bef3bab1a232457516b47b69a2a",
};
export async function verifyRetainedSourceEpochContract(env:NodeJS.ProcessEnv){
  await assertDisposableTestInfrastructure({operation:"retained source-epoch contract",requireRedis:false,env});
  const client=new pg.Client({connectionString:env.DATABASE_URL});
  await client.connect();
  try{
    const bodies=(await client.query(`SELECT proname,md5(prosrc) hash FROM pg_proc
      WHERE oid IN('public.crm_automatic_relationship_reasons(integer,integer,uuid,integer)'::regprocedure,
        'public.enforce_reviewed_contact_business_link()'::regprocedure)`)).rows;
    for(const [name,hash] of Object.entries(retainedSourceNativeBodies))
      assert.equal(bodies.find(row=>row.proname===name)?.hash,hash,"RETAINED_SOURCE_NATIVE_BODY_DRIFT");
    // Owner-approved declared artifact, not a test-only constraint relaxation.
    await client.query(readFileSync("migrations/0352_contact_mailbox_identity.sql","utf8"));
    // Restore actual source timestamp types missing from the fresh-DB snapshot.
    // This is the same forward, source-preserving declared correction.
    await client.query(readFileSync("migrations/0353_contact_readiness_timestamp_parity.sql","utf8"));
  }finally{await client.end();}
}
export async function migrateRetainedSourceEpoch(env:NodeJS.ProcessEnv){
  await assertDisposableTestInfrastructure({operation:"retained source-epoch migration",requireRedis:false,env});
  const root=process.cwd(),temporary=mkdtempSync(path.join(tmpdir(),"retained-native-epoch-"));
  try{
    cpSync(path.join(root,"migrations"),path.join(temporary,"migrations"),{recursive:true});
    const journalPath=path.join(temporary,"migrations/meta/_journal.json");
    const journal=JSON.parse(readFileSync(journalPath,"utf8"));
    const boundary=journal.entries.find((entry:any)=>entry.tag==="0348_import_identity_bridge_contract");
    assert(boundary,"RETAINED_SOURCE_EPOCH_JOURNAL_BOUNDARY_REQUIRED");
    journal.entries=journal.entries.filter((entry:any)=>entry.idx<=boundary.idx);
    writeFileSync(journalPath,JSON.stringify(journal));
    const code=await new Promise<number>((resolve,reject)=>{
      const child=spawn(process.execPath,[path.join(root,"node_modules/tsx/dist/cli.mjs"),
        "--tsconfig",path.join(root,"tsconfig.json"),path.join(root,"scripts/migrate.ts")],
      {env,cwd:temporary,stdio:"inherit"});
      child.once("error",reject);child.once("exit",code=>resolve(code??1));
    });
    assert.equal(code,0,"RETAINED_SOURCE_EPOCH_MIGRATION_FAILED");
  }finally{rmSync(temporary,{recursive:true,force:true});}
}
