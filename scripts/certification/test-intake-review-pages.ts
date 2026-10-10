import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import express from "express";
import bcrypt from "bcryptjs";
import {assertDisposableTestInfrastructure} from "../test-infrastructure-guard";
await assertDisposableTestInfrastructure({operation:"intake authenticated review pages",requireRedis:false});
const {pool}=await import("../../server/db");
const {setupAuth}=await import("../../server/replit_integrations/auth/replitAuth");
const {registerContactLinkCoverageRoutes}=await import("../../server/routes/contact-link-coverage");
const {listContactLinkCoverageCandidates}=await import("../../server/services/contact-link-coverage");
const app=express();app.use(express.json());
await setupAuth(app);
const unused=async()=>{throw new Error("UNUSED_REVIEW_FIXTURE_OPERATION");};
registerContactLinkCoverageRoutes(app,{getStatus:unused,listCandidates:listContactLinkCoverageCandidates,
  start:unused,step:unused,pause:unused,resume:unused,reviewBatch:unused,
  previewSourceRecoveryBatch:unused,applySourceRecoveryBatch:unused,auditSourceRecovery:unused});
const server=await new Promise<ReturnType<typeof app.listen>>(resolve=>{
  const value=app.listen(0,"127.0.0.1",()=>resolve(value));
});
const url=`http://127.0.0.1:${(server.address() as any).port}`;
let checks=0;
try {
  const contact=(await pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,company_name,record_class)
    VALUES('Review','Fixture',$1,'','Review Fixture','production') RETURNING id`,[`${randomUUID()}@gmail.com`])).rows[0];
  const business=(await pool.query(`INSERT INTO businesses(canonical_name,normalized_name,record_class)
    VALUES('Review Fixture','reviewfixture','canonical') RETURNING id`)).rows[0];
  for(let i=0;i<3;i++)await pool.query(`INSERT INTO contact_business_link_candidates
    (contact_id,business_id,source,source_version,candidate_key,confidence,created_at)
    VALUES($1,$2,'sdr_orchestration','contact_link_coverage_v1',$3,50,
      '2020-01-01T00:00:00.123456Z')`,[contact.id,business.id,randomUUID()]);
  const pagePath="/api/admin/contact-link-coverage/candidates";
  assert.equal((await fetch(url+pagePath)).status,401);checks++;
  const password=randomUUID(),hash=await bcrypt.hash(password,4);
  for(const role of ["admin","manager","agent"]) {
    const email=`${randomUUID()}@example.invalid`,id=randomUUID();
    await pool.query(`INSERT INTO users(id,email,password_hash,role) VALUES($1,$2,$3,$4)`,[id,email,hash,role]);
    const login=await fetch(url+"/api/auth/login",{method:"POST",
      headers:{"content-type":"application/json"},body:JSON.stringify({email,password})});
    assert.equal(login.status,200,"Real local sign-in must succeed");
    const cookie=login.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");
    const firstResponse=await fetch(url+pagePath+"?limit=1",{headers:{cookie}});
    if(role!=="admin"){assert.equal(firstResponse.status,403);checks++;continue;}
    assert.equal(firstResponse.status,200);checks++;
    const first=await firstResponse.json() as any;
    assert.equal(first.candidates.length,1);checks++;
    assert.equal(first.candidates[0].contactId,contact.id);checks++;
    assert(Object.keys(first.candidates[0].evidence).length>0,"First page must contain hydrated business evidence");checks++;
    const next=new URLSearchParams({limit:"1",afterCreatedAt:first.nextCursor.createdAt,afterId:first.nextCursor.id});
    const secondResponse=await fetch(url+pagePath+"?"+next,{headers:{cookie}});
    assert.equal(secondResponse.status,200);checks++;
    const second=await secondResponse.json() as any;
    assert.equal(second.candidates.length,1);checks++;
    assert.notEqual(second.candidates[0].candidateId,first.candidates[0].candidateId,
      "Lossless native timestamp cursor must advance, not repeat the last hydrated candidate");checks++;
    const thirdParams=new URLSearchParams({limit:"1",afterCreatedAt:second.nextCursor.createdAt,afterId:second.nextCursor.id});
    const third=await (await fetch(url+pagePath+"?"+thirdParams,{headers:{cookie}})).json() as any;
    assert.equal(third.candidates.length,1);checks++;
    assert(![first.candidates[0].candidateId,second.candidates[0].candidateId].includes(third.candidates[0].candidateId));checks++;
    const endParams=new URLSearchParams({limit:"1",afterCreatedAt:third.nextCursor.createdAt,afterId:third.nextCursor.id});
    const end=await (await fetch(url+pagePath+"?"+endParams,{headers:{cookie}})).json() as any;
    assert.deepEqual(end.candidates,[]);assert.equal(end.nextCursor,null);checks+=2;
  }
  console.log(`Authenticated native review pages: ${checks} checks passed; admin hydration and lossless keyset; manager/agent 403; unsigned 401`);
} catch(error) {
  console.error(error);
  process.exitCode=1;
} finally {
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  await pool.end();
  process.exit(process.exitCode ?? 0);
}
