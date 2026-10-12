import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {assertDisposableTestInfrastructure} from "../test-infrastructure-guard";
import {applyCertificationProviderDenyBoundary,getBlockedCertificationNetworkAttemptCount} from "../certification-provider-deny";
await assertDisposableTestInfrastructure({operation:"contact mailbox identity certification",requireRedis:false});
applyCertificationProviderDenyBoundary({fatal:true});
const {pool}=await import("../../server/db");
const {writeContact}=await import("../../server/services/contact-writer");
const {storage}=await import("../../server/storage");
const {sameMailboxContactIdentity}=await import("../../server/services/contact-mailbox-identity");
let checks=0;
const check=(value:unknown,label:string)=>{assert(value,label);checks++;};
const suffix=randomUUID(),email=`shared.${suffix}@example.invalid`;
const site={email,firstName:"",lastName:"",companyName:"Shared brand",phone:"9545550100",
  address:"100 Main Street",city:"Fort Lauderdale",state:"FL"};
const event=(key:string)=>`mailbox-cert:${suffix}:${key}`;
const create=(key:string,mutation:any)=>writeContact({
  mode:"local_only",mutation:{phone:"",...mutation},provenance:{sourceCategory:"manual_crm",sourceType:"dashboard",
    eventKey:event(key),actorType:"system"},
  actor:{actorType:"system"},hookPolicy:{source:"cro03",deferValidation:true,
    deferReadiness:true,deferLeadScoring:true,suppressProviderProjection:true},
});
const baseline=async()=>(await pool.query(`SELECT
  (SELECT count(*)::int FROM contact_provider_projections) providers,
  (SELECT count(*)::int FROM provider_operations) operations,
  (SELECT count(*)::int FROM communication_events) communications,
  (SELECT count(*)::int FROM validation_intents) validation_intents`)).rows[0];
try {
  const before=await baseline();
  const first=await create("first",site);
  const second=await create("second",{...site,address:"200 Other Road",city:"Wilton Manors"});
  check(first.id!==second.id,"Separate shared-brand sites retain separate contacts despite same email/phone");
  assert.equal((await create("first",site)).id,first.id);checks++;
  assert.equal((await create("third-source",{...site,state:" Florida "})).id,first.id);checks++;
  assert.equal(await storage.getContactByEmail(email),undefined);checks++;
  assert.equal((await storage.getContactByEmail(email,site))?.id,first.id);checks++;
  const person=await create("person",{email,firstName:"Jane",lastName:"Smith",phone:"9545550200"});
  check(![first.id,second.id].includes(person.id),"Shared mailbox does not collapse unrelated people/businesses");
  assert.equal((await create("person-source",{email,firstName:"Jane",lastName:"Smith",
    phone:"+1 (954) 555-0200"})).id,person.id);checks++;
  const other=await create("other-person",{email,firstName:"John",lastName:"Smith",phone:"9545550200"});
  check(other.id!==person.id,"Conflicting names are not merged on shared switchboard");
  const parallel=await Promise.all(Array.from({length:4},()=>create("concurrent",{
    email:`parallel.${suffix}@example.invalid`,firstName:"Concurrent",lastName:"Person"})));
  check(new Set(parallel.map(row=>row.id)).size===1,"Concurrent identical source retries create one contact");
  const across=await Promise.all(["a","b","c"].map(key=>create(`cross-${key}`,{
    email:`across.${suffix}@example.invalid`,firstName:"Cross",lastName:"Source"})));
  check(new Set(across.map(row=>row.id)).size===1,"Concurrent corroborated cross-source identity creates once");
  const noEvidence=await create("unproven",{email,firstName:"",lastName:""});
  check(![first.id,second.id,person.id,other.id].includes(noEvidence.id),"Email-only input cannot silently select an existing identity");
  assert.equal((await create("unproven",{email,firstName:"",lastName:""})).id,noEvidence.id);checks++;
  await pool.query(`UPDATE contacts SET archived_at=clock_timestamp() WHERE id=$1`,[second.id]);
  const replacement=await create("replacement",{...site,address:"200 Other Road",city:"Wilton Manors"});
  check(replacement.id!==second.id,"New source does not revive an archived contact");
  assert.equal((await create("second",{...site,address:"200 Other Road",city:"Wilton Manors"})).id,second.id);checks++;
  check(!sameMailboxContactIdentity(site,{...site,address:"300 Third Street"}),
    "Location conflicts defeat same-brand same-phone identity");
  check(!sameMailboxContactIdentity({...site,ghlContactId:"one"},{...site,ghlContactId:"two"}),
    "Distinct GHL IDs are not consolidated by shared email");
  const contactRows=(await pool.query("SELECT * FROM contacts WHERE id=ANY($1::int[]) ORDER BY id",
    [[first.id,second.id,person.id,other.id]])).rows;
  await pool.query("UPDATE contacts SET archived_at=NULL WHERE id=$1",[second.id]);
  check((await pool.query("SELECT count(*)::int n FROM contacts WHERE email=$1 AND archived_at IS NULL",
    [email])).rows[0].n===6,"Restoring a distinct shared-mailbox contact is supported");
  check(contactRows.every(row=>row.email===email),"Real mailbox fields stay intact");
  const ambiguous=`ambiguous.${suffix}@example.invalid`;
  await pool.query(`INSERT INTO contacts(first_name,last_name,email,phone)
    VALUES('Ambiguous','Person',$1,''),('Ambiguous','Person',$1,'')`,[ambiguous]);
  await assert.rejects(create("ambiguous",{email:ambiguous,firstName:"Ambiguous",lastName:"Person"}),
    (error:any)=>error.message==="CONTACT_MAILBOX_IDENTITY_AMBIGUOUS"&&error.candidateContactIds.length===2);checks++;
  check((await pool.query("SELECT count(*)::int n FROM contacts WHERE email=$1",[ambiguous])).rows[0].n===2,
    "Ambiguous identity cannot silently select a row or manufacture another duplicate");
  const uid=randomUUID(),login=`login.${suffix}@example.invalid`;
  await pool.query("INSERT INTO users(id,email) VALUES($1,$2)",[uid,login]);
  await assert.rejects(pool.query("INSERT INTO users(id,email) VALUES($1,$2)",[randomUUID(),login]),
    (error:any)=>error.code==="23505");checks++;
  const indexes=(await pool.query(`SELECT indexname,indexdef FROM pg_indexes WHERE tablename='contacts'
    AND indexname IN ('contacts_email_unique_idx','contacts_active_email_idx')`)).rows;
  check(indexes.length===1&&indexes[0].indexname==="contacts_active_email_idx"&&
    !indexes[0].indexdef.includes("UNIQUE"),"Migrated native schema uses nonunique active-mailbox index");
  assert.deepEqual(await baseline(),before);checks++;
  assert.equal(getBlockedCertificationNetworkAttemptCount(),0);checks++;
  console.log(`CRM mailbox identity: ${checks} checks passed; login uniqueness preserved; no provider/outbound effects`);
}catch(error){console.error(error);process.exitCode=1;}
finally{await pool.end();process.exit(process.exitCode??0);}
