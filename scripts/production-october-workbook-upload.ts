/**
 * Operator for the five explicitly authorized original attachments.
 * HTTP only: uses the ordinary upload endpoint, never a database/pipeline writer.
 * Credentials stay in memory; raw responses stay in ignored private evidence.
 */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync,mkdirSync,writeFileSync,existsSync,copyFileSync} from "node:fs";
import {readTabularImportWithCoordinates} from "../server/services/tabular-import-reader";
import {classifyCsvSourceFormat} from "../server/services/import-normalizer";

const base=new URL(process.argv[2] ?? "");
assert(base.protocol==="https:" && base.origin==="https://dev.libertybancard.com","VERIFIED_PRODUCTION_ORIGIN_REQUIRED");
assert(process.argv.includes("--authorized-five-october-imports"),"EXPLICIT_IMPORT_AUTHORIZATION_REQUIRED");
const onlyArgument=process.argv.find(value=>value.startsWith("--only-index="));
const onlyIndex=onlyArgument ? Number(onlyArgument.split("=")[1]) : undefined;
assert(onlyIndex===undefined || (Number.isInteger(onlyIndex) && onlyIndex>=0 && onlyIndex<5),"INVALID_AUTHORIZED_FILE_INDEX");
const fromArgument=process.argv.find(value=>value.startsWith("--from-index="));
const fromIndex=fromArgument ? Number(fromArgument.split("=")[1]) : 0;
assert(Number.isInteger(fromIndex) && fromIndex>=0 && fromIndex<5,"INVALID_AUTHORIZED_START_INDEX");
const fixtures=[
  ["Outscraper-20261002160911s8d6b_1791037870877.xlsx","5079ea20012d1ca5e8c0eae9c0aa8460a6ce4c91eb10784587f36026675cf833",537],
  ["Outscraper-20261002160955s00ed_1791037870876.xlsx","506fe8119590a0ab821167e50f15584aea29da441a2f393ff64f9b32837940a4",578],
  ["Outscraper-20261002161052s68e5_1791037870877.xlsx","4c02771046abc941d7475aa40a4cfc56dc95e2dbf5ff6bb3f43013577852a581",513],
  ["Outscraper-20261002161147s2b94_1791037870876.xlsx","bec23f5270048a3e1cbba641b6727e9d813b14106abe456a881ed9eb7a039230",653],
  ["Outscraper-20261002161239s8aab_1791037870874.xlsx","c3fd1dd8da6eb4bf504c91b3342d59ebd5fb5b12d46c767c178b5b4c5bd4baca",633],
] as const;
const dir="generated-artifacts/private-intake-october-production";
mkdirSync(dir,{recursive:true,mode:0o700});
const save=(name:string,value:unknown)=>writeFileSync(`${dir}/${name}.json`,JSON.stringify(value,null,2),{mode:0o600});
let cookie="",csrf="";
async function request(route:string,method="GET",body?:BodyInit,contentType?:string,timeoutMs=90_000){
  const headers=new Headers();
  if(cookie)headers.set("cookie",cookie);
  if(csrf && method!=="GET")headers.set("x-csrf-token",csrf);
  if(contentType)headers.set("content-type",contentType);
  const started=Date.now();
  const response=await fetch(new URL(route,base),{method,headers,body,redirect:"error",signal:AbortSignal.timeout(timeoutMs)});
  if(route==="/api/auth/login")cookie=response.headers.getSetCookie().map(v=>v.split(";")[0]).join("; ");
  const data=await response.json().catch(()=>({nonJson:true}));
  return {status:response.status,elapsedMs:Date.now()-started,body:data};
}

const parsed=[];
for(const [file,hash,rows] of fixtures){
  const bytes=readFileSync(`attached_assets/${file}`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"),hash);
  const data=await readTabularImportWithCoordinates(bytes,file);
  assert.equal(data.rows.length,rows);
  const sourceFormat=classifyCsvSourceFormat(Object.keys(data.rows[0]));
  assert.equal(sourceFormat,"google_maps_outscraper");
  parsed.push({file,hash,rows,sourceFormat,bytes:bytes.length,columns:Object.keys(data.rows[0]).length});
}
save("source-preflight",{observedAt:new Date().toISOString(),authorizedSourceRows:2914,files:parsed});
if(process.argv.includes("--await-published-admission")){
  // One-off operator wait, not an application worker or alternate intake path.
  // Only public reads until a new serving build appears; then confirm the real
  // scoped policy before sending any authorized original workbook.
  const oldSha=process.argv.find(value=>value.startsWith("--previous-sha="))?.split("=")[1]
    ?? "a7b51b19a9c97b31a812e1260260008bbed06af9";
  assert(/^[a-f0-9]{40}$/.test(oldSha),"INVALID_PREVIOUS_SERVING_SHA");
  const deadline=Date.now()+30*60_000;
  console.log(JSON.stringify({event:"WAITING_FOR_PUBLISHED_INTAKE_CORRECTION",previousSha:oldSha,
    sourceRows:2914,waitMinutes:30}));
  let delivered=false;
  while(Date.now()<deadline){
    try{
      const health=await request("/api/health","GET",undefined,undefined,30_000);
      if(health.status===200 && /^[a-f0-9]{40}$/.test(health.body.sha ?? "") && health.body.sha!==oldSha){
        console.log(JSON.stringify({event:"NEW_PUBLISHED_BUILD_OBSERVED",sha:health.body.sha}));
        delivered=true;break;
      }
    }catch{
      // A transient read is not delivery, nor permission to upload.
    }
    await new Promise(resolve=>setTimeout(resolve,30_000));
  }
  assert(delivered,"PUBLICATION_WAIT_EXPIRED_NO_IMPORTS_ATTEMPTED");
}
assert(process.env.ADMIN_SEED_EMAIL && process.env.ADMIN_SEED_PASSWORD,"ADMIN_SECRETS_REQUIRED");
const login=await request("/api/auth/login","POST",JSON.stringify({
  email:process.env.ADMIN_SEED_EMAIL,password:process.env.ADMIN_SEED_PASSWORD,
}),"application/json");
assert.equal(login.status,200,"PRODUCTION_LOGIN_FAILED");
assert(cookie,"SESSION_COOKIE_MISSING");
const token=await request("/api/csrf-token");
assert.equal(token.status,200);
csrf=token.body.token;
assert(typeof csrf==="string" && csrf,"CSRF_REQUIRED");
const actor=await request("/api/auth/user");
assert.equal(actor.status,200);
assert.equal(actor.body.role,"admin","PRODUCTION_ADMIN_REQUIRED");
if(process.argv.includes("--probe-admission") || process.argv.includes("--await-published-admission")){
  const form=new FormData();
  form.append("file",new Blob(["invalid extension"],{type:"text/plain"}),"admission-probe.txt");
  const result=await request("/api/leads/import-csv","POST",form);
  save("admission-probe",result);
  assert.equal(result.status,400,"SCOPED_UPLOAD_POLICY_NOT_DELIVERED");
  assert.equal(result.body.message,"Unsupported intake file type. Accepted: CSV or XLSX.");
  console.log(JSON.stringify({event:"ORDINARY_INTAKE_ADMISSION_POLICY_CONFIRMED",status:400,
    importClaims:0,scope:"Authenticated ordinary route rejects unsupported content before processing"}));
  if(process.argv.includes("--probe-admission"))process.exit(0);
}
// Preserve the first pre-claim failure and its control baseline when the
// already-authorized uploads resume after publication; do not overwrite proof.
if(existsSync(`${dir}/upload-0.json`) && !existsSync(`${dir}/upload-0-original-admission-failure.json`)){
  copyFileSync(`${dir}/upload-0.json`,`${dir}/upload-0-original-admission-failure.json`);
  if(existsSync(`${dir}/status-before.json`))copyFileSync(`${dir}/status-before.json`,`${dir}/status-original-admission-failure.json`);
}
const before=await request("/api/canonical-enrichment/status");
assert.equal(before.status,200,"PRIMARY_STATUS_REQUIRED");
save(onlyIndex===undefined && fromIndex===0 ? "status-before" : `status-before-${onlyIndex ?? fromIndex}`,before);
console.log(JSON.stringify({event:"authorized_october_upload_preflight",files:5,sourceRows:2914,onlyIndex}));

for(const [index,[file,hash,rows]] of fixtures.entries()){
  if(onlyIndex!==undefined && index!==onlyIndex)continue;
  if(index<fromIndex)continue;
  const form=new FormData();
  form.append("file",new Blob([readFileSync(`attached_assets/${file}`)],{
    type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }),file);
  console.log(JSON.stringify({event:"ordinary_upload_start",index,hash,rows,at:new Date().toISOString()}));
  const result=await request("/api/leads/import-csv","POST",form,undefined,3_600_000);
  save(`upload-${index}`,{observedAt:new Date().toISOString(),file,hash,expectedRows:rows,...result});
  console.log(JSON.stringify({event:"ordinary_upload_response",index,hash,status:result.status,
    elapsedMs:result.elapsedMs,importId:result.body.import?.id,
    executionId:result.body.executionId ?? result.body.import?.executionId ?? result.body.import?.execution_id ?? result.body.execution?.id,
    replayed:result.body.replayed ?? false,counts:result.body.counts,at:new Date().toISOString()}));
  // Do not hide partial/ambiguous HTTP outcomes or blindly send another upload.
  assert(result.status===201 || result.status===202 || (result.status===200 && result.body.replayed),"ORDINARY_UPLOAD_NEEDS_RECONCILIATION");
  if(result.status===202){
    assert.equal(result.body.status,"processing");
    assert.equal(result.body.fileHash,hash);
    assert.equal(result.body.totalRows,rows);
    assert.equal(result.body.executionId,result.body.import.executionId ?? result.body.import.execution_id);
    assert(result.body.import.id,"ACCEPTED_IMPORT_ID_REQUIRED");
  }
  const importId=result.body.import?.id;
  if(importId){
    const ledger=await request(`/api/csv-imports/${importId}`);
    save(`ledger-${index}`,ledger);
    assert.equal(ledger.status,200);
    assert.equal(ledger.body.executionId,
      result.body.executionId ?? result.body.import.executionId ?? result.body.import.execution_id);
    assert.equal(ledger.body.totalRows,rows);
    if(result.status!==202)assert.equal(ledger.body.processedRows,rows);
    else console.log(JSON.stringify({event:"ordinary_upload_durably_accepted",index,hash,rows,
      executionId:result.body.executionId,importId,pendingFulfillment:true,
      processedRows:ledger.body.processedRows}));
  }
}
const after=await request("/api/canonical-enrichment/status");
save(onlyIndex===undefined && fromIndex===0 ? "status-after" : `status-after-${onlyIndex ?? fromIndex}`,after);
assert.equal(after.status,200);
console.log(JSON.stringify({event:"authorized_october_upload_requests_reconciled",
  files:onlyIndex===undefined ? 5-fromIndex : 1,
  sourceRows:onlyIndex===undefined ? fixtures.slice(fromIndex).reduce((n,f)=>n+f[2],0) : fixtures[onlyIndex][2],
  qualification:"Original-byte ordinary HTTP acceptance or completed/replayed response only; pending row accounting and full native mailbox/hold disposition require separate receipt reconciliation."}));
