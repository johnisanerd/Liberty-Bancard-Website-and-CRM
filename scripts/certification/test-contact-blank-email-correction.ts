import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import express from "express";
import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import {assertDisposableTestInfrastructure} from "../test-infrastructure-guard";
await assertDisposableTestInfrastructure({operation:"contact blank email correction",requireRedis:false});
const {pool}=await import("../../server/db");
const {commandContactLifecycle}=await import("../../server/services/contact-lifecycle-command");
const {contactLifecycleIdentityFingerprint}=await import("../../server/services/contact-lifecycle-identity");
const {setupAuth}=await import("../../server/replit_integrations/auth/replitAuth");
const {registerContactsRoutes}=await import("../../server/routes/contacts");
const {csrfTokenEndpoint}=await import("../../server/middleware/csrf");
const app=express();app.use(express.json());app.use(cookieParser());await setupAuth(app);
app.get("/api/csrf-token",csrfTokenEndpoint);registerContactsRoutes(app);
const server=await new Promise<ReturnType<typeof app.listen>>(resolve=>{
  const value=app.listen(0,"127.0.0.1",()=>resolve(value));
});
const url=`http://127.0.0.1:${(server.address() as any).port}`;
let checks=0;
try {
  const actorId=randomUUID();
  const principal=(await pool.query(`INSERT INTO users(id,email,role) VALUES($1,$2,'admin')
    RETURNING auth_epoch,account_version`,[actorId,`${randomUUID()}@example.invalid`])).rows[0];
  const actor={id:actorId,authEpoch:principal.auth_epoch,accountVersion:principal.account_version};
  const rows=(await pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,record_class)
    VALUES('Blank','One','','','production'),('Blank','Two','   ','','production'),
    ('Real','Mailbox',$1,'','production') RETURNING *`,[`${randomUUID()}@example.invalid`])).rows;
  const camel=(r:any)=>Object.fromEntries(Object.entries(r).map(([key,value])=>[
    key.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),value]));
  const select=(r:any)=>({id:r.id,expectedVersion:r.lifecycle_version,
    expectedOwner:r.assigned_to,expectedRecordClass:r.record_class,expectedEmail:r.email,
    expectedIdentityFingerprint:contactLifecycleIdentityFingerprint(camel(r))});
  const command={commandId:randomUUID(),expectedActorId:actorId,expectedAccountVersion:actor.accountVersion,
    items:rows.slice(0,2).map(select)};
  const counts=async()=> (await pool.query(`SELECT
    (SELECT count(*) FROM contact_provider_projections)::int providers,
    (SELECT count(*) FROM audit_logs WHERE action='contact_blank_email_normalized')::int audits`)).rows[0];
  const baseline=await counts();
  await assert.rejects(commandContactLifecycle(actor,"normalize_blank_email",{
    ...command,items:[select(rows[0]),select(rows[2])]}),/state, owner or classification changed/);checks++;
  assert.deepEqual(await counts(),baseline,"Mixed invalid sets must have no partial updates/audits");checks++;
  await assert.rejects(commandContactLifecycle(actor,"normalize_blank_email",{
    ...command,items:[{...select(rows[0]),expectedEmail:undefined}]}),/state, owner or classification changed/);checks++;
  await assert.rejects(commandContactLifecycle(actor,"normalize_blank_email",{
    ...command,items:[{...select(rows[0]),expectedIdentityFingerprint:"0".repeat(64)}]}),/state, owner or classification changed/);checks++;
  const result=await commandContactLifecycle(actor,"normalize_blank_email",command);
  assert.equal(result.changed,2);checks++;
  const after=(await pool.query("SELECT * FROM contacts WHERE id=ANY($1::int[]) ORDER BY id",
    [rows.map(r=>r.id)])).rows;
  for(let i=0;i<2;i++) {
    assert.equal(after[i].email,null);checks++;
    assert.equal(after[i].lifecycle_version,rows[i].lifecycle_version+1);checks++;
    for(const key of Object.keys(rows[i]).filter(k=>!["email","lifecycle_version"].includes(k)))
      assert.deepEqual(after[i][key],rows[i][key],`Representation repair must preserve ${key}`);
    checks++;
  }
  assert.deepEqual(after[2],rows[2],"Nonblank mailbox must remain unchanged");checks++;
  const replay=await commandContactLifecycle(actor,"normalize_blank_email",command);
  assert.equal(replay.replayed,true);checks++;
  assert.equal(replay.changed,2);checks++;
  assert.deepEqual(await counts(),{providers:baseline.providers,audits:baseline.audits+2});checks++;
  await assert.rejects(commandContactLifecycle(actor,"archive",command),/payload differs/);checks++;
  const path="/api/admin/contacts/normalize-blank-emails";
  assert.equal((await fetch(url+path,{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({})})).status,401);checks++;
  const password=randomUUID();
  await pool.query("UPDATE users SET password_hash=$2 WHERE id=$1",[actorId,await bcrypt.hash(password,4)]);
  const userEmail=(await pool.query("SELECT email FROM users WHERE id=$1",[actorId])).rows[0].email;
  const login=await fetch(url+"/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({email:userEmail,password})});
  assert.equal(login.status,200);checks++;
  let cookie=login.headers.getSetCookie().map(c=>c.split(";")[0]).join("; ");
  const csrfResponse=await fetch(url+"/api/csrf-token",{headers:{cookie}});
  const csrf=(await csrfResponse.json() as any).token;
  cookie+="; "+csrfResponse.headers.getSetCookie().map(c=>c.split(";")[0]).join("; ");
  const headers={cookie,"content-type":"application/json","x-csrf-token":csrf};
  const fresh=(await pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,record_class)
    VALUES('HTTP','Blank','','','production') RETURNING *`)).rows[0];
  const httpCommand={...command,commandId:randomUUID(),items:[select(fresh)]};
  assert.equal((await fetch(url+path,{method:"POST",headers:{cookie,"content-type":"application/json"},
    body:JSON.stringify(httpCommand)})).status,403);checks++;
  const response=await fetch(url+path,{method:"POST",headers,body:JSON.stringify(httpCommand)});
  assert.equal(response.status,200);checks++;
  assert.equal((await response.json() as any).changed,1);checks++;
  await pool.query("UPDATE users SET role='manager' WHERE id=$1",[actorId]);
  assert.equal((await fetch(url+path,{method:"POST",headers,body:JSON.stringify(httpCommand)})).status,403);checks++;
  await pool.query("UPDATE users SET role='agent' WHERE id=$1",[actorId]);
  assert.equal((await fetch(url+path,{method:"POST",headers,body:JSON.stringify(httpCommand)})).status,403);checks++;
  await pool.query("UPDATE users SET role='manager' WHERE id=$1",[actorId]);
  await assert.rejects(commandContactLifecycle(actor,"normalize_blank_email",{
    ...command,commandId:randomUUID(),items:[select(rows[2])]}),/unavailable/);checks++;
  console.log(`Audited blank-email correction: ${checks} checks passed; no providers, timestamps or identity/history rewrites`);
} catch(error) {
  console.error(error);
  process.exitCode=1;
} finally {
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  await pool.end();
  process.exit(process.exitCode ?? 0);
}
