/**
 * Authorized maintenance through existing authenticated commands only.
 * No SQL writes, provider calls, contact merging, relationship transfer or DDL.
 * Evidence and receipts stay in an ignored private directory, never stdout.
 */
import {readFileSync,writeFileSync,mkdirSync,chmodSync} from "node:fs";
import {resolve} from "node:path";
import {randomUUID} from "node:crypto";
import {contactLifecycleIdentityFingerprint} from "../server/services/contact-lifecycle-identity";

const arg=(name:string)=>process.argv.find(v=>v.startsWith(`--${name}=`))?.slice(name.length+3);
const base=new URL(arg("base-url") ?? "");
if(base.protocol!=="https:" || base.pathname!=="/" || base.search || base.username || base.password)
  throw new Error("HTTPS_PRODUCTION_ORIGIN_REQUIRED");
const directory=resolve(arg("private-dir") ?? "generated-artifacts/private-intake-september/correction");
if(!directory.startsWith(resolve("generated-artifacts")+"/"))throw new Error("IGNORED_PRIVATE_DIRECTORY_REQUIRED");
mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
const save=(name:string,value:unknown)=>writeFileSync(`${directory}/${name}.json`,JSON.stringify(value,null,2),{mode:0o600});
const norm=(v:unknown)=>String(v??"").normalize("NFKC").trim().toLowerCase().replace(/\s+/g," ");
const phone=(v:unknown)=>{const d=String(v??"").replace(/\D/g,"");return d.length===11&&d[0]==="1"?d.slice(1):d;};
const state=(v:unknown)=>norm(v)==="florida"?"fl":norm(v);
function sameIdentity(a:any,b:any) {
  // Shared email alone, a shared brand, or a shared switchboard is insufficient.
  if(a.email!==b.email || !phone(a.phone) || phone(a.phone).length!==10 ||
    phone(a.phone)!==phone(b.phone))return false;
  for(const key of ["first_name","last_name","company_name","address","city"]) {
    if(norm(a[key])&&norm(b[key])&&norm(a[key])!==norm(b[key]))return false;
  }
  if(state(a.state)&&state(b.state)&&state(a.state)!==state(b.state))return false;
  if(a.ghl_contact_id&&b.ghl_contact_id&&a.ghl_contact_id!==b.ghl_contact_id)return false;
  const names=(x:any)=>norm(`${x.first_name??""} ${x.last_name??""}`);
  return (!!norm(a.company_name)&&norm(a.company_name)===norm(b.company_name)) ||
    (!!names(a)&&names(a)===names(b));
}
const evidence:any[]=JSON.parse(readFileSync(arg("evidence") ?? "generated-artifacts/private-intake-september/duplicate-contact-evidence.json","utf8"));
const groups=Map.groupBy(evidence,row=>row.email);
const pairs:Array<{archive:any;keep:any}>=[];
const held:number[][]=[];
for(const rows of groups.values()) {
  // Prefer existing relationships and source history; never move either.
  rows.sort((a,b)=>(Number(!!b.business_id)+Number(b.current_decisions>0))*100000-
    (Number(!!a.business_id)+Number(a.current_decisions>0))*100000+
    (b.source_events-a.source_events)*1000+Number(!!b.ghl_contact_id)*100-
    Number(!!a.ghl_contact_id)*100+(b.deals-a.deals)*10+a.id-b.id);
  const keep=rows[0];
  for(const candidate of rows.slice(1)) {
    if(!candidate.business_id && !candidate.current_decisions && sameIdentity(keep,candidate))
      pairs.push({keep,archive:candidate});
    else held.push([keep.id,candidate.id]);
  }
}
save("classification",{pairs,held,origin:base.origin});
let cookie="",csrf="";
async function request(route:string,method="GET",body?:unknown):Promise<any> {
  const headers:Record<string,string>={"content-type":"application/json"};
  if(cookie)headers.cookie=cookie;
  if(csrf&&method!=="GET")headers["x-csrf-token"]=csrf;
  const res=await fetch(new URL(route,base),{method,headers,
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
  if(route==="/api/auth/login")cookie=res.headers.getSetCookie().map(s=>s.split(";")[0]).join("; ");
  const data=await res.json().catch(()=>null);
  if(!res.ok) {
    if(route!=="/api/auth/login")save("http-refusal",{route,status:res.status,body:data});
    throw new Error(`MAINTENANCE_HTTP_${res.status}:${route}`);
  }
  return data;
}
if(!process.env.ADMIN_SEED_EMAIL||!process.env.ADMIN_SEED_PASSWORD)throw new Error("ADMIN_SECRETS_REQUIRED");
await request("/api/auth/login","POST",{email:process.env.ADMIN_SEED_EMAIL,password:process.env.ADMIN_SEED_PASSWORD});
csrf=(await request("/api/csrf-token")).token;
const actor=await request("/api/auth/user");
if(actor.role!=="admin")throw new Error("ADMIN_PRINCIPAL_REQUIRED");
if(process.argv.includes("--probe-contract")) {
  // Empty set cannot archive contacts; obtain the deployed validation contract
  // without silently downgrading a rejected versioned command.
  await request("/api/contacts/bulk-delete","DELETE",{});
  throw new Error("EMPTY_ARCHIVE_COMMAND_UNEXPECTEDLY_ACCEPTED");
}
if(arg("review-ids")) {
  const ids=arg("review-ids")!.split(",").map(Number);
  if(!ids.length||ids.length>100||ids.some(id=>!Number.isSafeInteger(id)||id<=0))
    throw new Error("INVALID_REVIEW_SET");
  const rows=[];
  for(const id of ids)rows.push(await request(`/api/contacts/${id}`));
  save("retained-identity-review",rows);
  console.log(JSON.stringify({event:"production_identity_review",contacts:rows.length,mutations:0}));
  process.exit(0);
}
if(process.argv.includes("--normalize-blanks")) {
  const ids:number[]=JSON.parse(readFileSync(`${directory}/blank-contact-ids.json`,"utf8"));
  if(!ids.length || ids.length>5000 || new Set(ids).size!==ids.length ||
    ids.some(id=>!Number.isSafeInteger(id)||id<=0))throw new Error("INVALID_BLANK_CONTACT_SET");
  const blanks=[];
  const before=[];
  for(const id of ids) {
    const row=await request(`/api/contacts/${id}`);
    if(row.archivedAt||typeof row.email!=="string"||row.email.trim()!=="")throw new Error("BLANK_SELECTION_DRIFT");
    blanks.push({id,expectedVersion:row.lifecycleVersion,expectedOwner:row.assignedTo,
      expectedRecordClass:row.recordClass,expectedEmail:row.email,
      expectedIdentityFingerprint:contactLifecycleIdentityFingerprint(row)});
    before.push(row);
  }
  save("blank-before",before);
  const command={commandId:randomUUID(),expectedActorId:actor.id,expectedAccountVersion:actor.accountVersion,items:blanks};
  save("blank-command",command);
  console.log(JSON.stringify({event:"production_blank_email_preview",contacts:blanks.length,providerActions:0}));
  if(process.argv.includes("--apply")) {
    // Bounded requests respect the existing body limit without relaxing pins.
    // Persist each exact command before dispatch for confirmation-loss replay.
    let normalized=0;
    for(let offset=0;offset<command.items.length;offset+=100) {
      const batch={...command,commandId:randomUUID(),items:command.items.slice(offset,offset+100)};
      const index=String(offset/100).padStart(3,"0");
      save(`blank-command-${index}`,batch);
      const result=await request("/api/admin/contacts/normalize-blank-emails","POST",batch);
      save(`blank-receipt-${index}`,result);
      if(result.changed!==batch.items.length)throw new Error("BLANK_RECEIPT_MISMATCH");
      normalized+=result.changed;
      console.log(JSON.stringify({event:"production_blank_email_batch_committed",
        normalized:result.changed,totalNormalized:normalized,providerActions:0}));
    }
    save("blank-receipt",{changed:normalized,batches:Math.ceil(command.items.length/100)});
    console.log(JSON.stringify({event:"production_blank_email_committed",normalized,providerActions:0}));
  }
  process.exit(0);
}
if(process.argv.includes("--replay-archive")) {
  const command=JSON.parse(readFileSync(`${directory}/archive-command.json`,"utf8"));
  if(command.expectedActorId!==actor.id)throw new Error("REPLAY_PRINCIPAL_DRIFT");
  const result=await request("/api/contacts/bulk-delete","DELETE",command);
  save("archive-receipt",result);
  if(result.archived!==command.items.length||result.permanentlyDeleted!==0)throw new Error("ARCHIVE_RECEIPT_MISMATCH");
  console.log(JSON.stringify({event:"production_contact_correction_replayed",archived:result.archived,replayed:result.replayed}));
  process.exit(0);
}
if(process.argv.includes("--replay-blanks")) {
  const command=JSON.parse(readFileSync(`${directory}/blank-command.json`,"utf8"));
  if(command.expectedActorId!==actor.id)throw new Error("REPLAY_PRINCIPAL_DRIFT");
  const result=await request("/api/admin/contacts/normalize-blank-emails","POST",command);
  save("blank-receipt",result);
  if(result.changed!==command.items.length)throw new Error("BLANK_RECEIPT_MISMATCH");
  console.log(JSON.stringify({event:"production_blank_email_replayed",normalized:result.changed,replayed:result.replayed}));
  process.exit(0);
}
const items=[];
const verified=[];
for(const pair of pairs) {
  const [keep,row]=await Promise.all([request(`/api/contacts/${pair.keep.id}`),request(`/api/contacts/${pair.archive.id}`)]);
  const asEvidence=(r:any)=>({email:r.email,first_name:r.firstName,last_name:r.lastName,
    company_name:r.companyName,phone:r.phone,address:r.address,city:r.city,state:r.state,ghl_contact_id:r.ghlContactId});
  if(keep.archivedAt||row.archivedAt||row.businessId||!sameIdentity(asEvidence(keep),asEvidence(row)))
    throw new Error("IDENTITY_OR_RELATIONSHIP_DRIFT");
  items.push({id:row.id,expectedVersion:row.lifecycleVersion,expectedOwner:row.assignedTo,
    expectedRecordClass:row.recordClass,
    ...(process.argv.includes("--identity-pin")?{expectedIdentityFingerprint:contactLifecycleIdentityFingerprint(row)}:{})});
  verified.push({keep,row,identityFingerprint:contactLifecycleIdentityFingerprint(row)});
}
save("verified-before",{actorId:actor.id,contacts:verified});
console.log(JSON.stringify({event:"production_contact_correction_preview",confirmedDuplicateArchives:items.length,
  preservedAmbiguousPairs:held.length,providerActions:0,relationshipTransfers:0,blankEmailWrites:0}));
if(process.argv.includes("--apply")&&items.length) {
  // Persist the exact command before dispatch so a response loss is replayable.
  const command={commandId:randomUUID(),expectedActorId:actor.id,expectedAccountVersion:actor.accountVersion,items};
  save("archive-command",command);
  const result=await request("/api/contacts/bulk-delete","DELETE",command);
  save("archive-receipt",result);
  if(result.archived!==items.length||result.permanentlyDeleted!==0)throw new Error("ARCHIVE_RECEIPT_MISMATCH");
  console.log(JSON.stringify({event:"production_contact_correction_committed",archived:result.archived,
    permanentlyDeleted:0,providerActions:0,relationshipTransfers:0}));
}
