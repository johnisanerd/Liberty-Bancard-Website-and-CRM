import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {assertDisposableTestInfrastructure} from "../test-infrastructure-guard";
import {applyCertificationProviderDenyBoundary,getBlockedCertificationNetworkAttemptCount} from "../certification-provider-deny";
await assertDisposableTestInfrastructure({operation:"zerobounce-ambiguous-recovery",requireRedis:false});
process.env.VG_PROVIDER_DENY_MODE="1";applyCertificationProviderDenyBoundary({fatal:true});
const {pool,db}=await import("../../server/db");
const svc=await import("../../server/services/zerobounce-ambiguous-recovery");
const addr=await import("../../server/services/canonical-address-validation");
let checks=0;
const ok=(v:unknown,m:string)=>{assert(v,m);checks++;};
const hashOf=(e:string)=>createHash("sha256").update(e).digest("hex");
const tag=randomUUID().slice(0,8);

// Fixture: an address whose earlier call was dispatched and ended in a timeout with unknown billing.
async function ambiguous(label:string,o:{ageHours?:number;intent?:boolean;fresh?:boolean;legacyOp?:boolean}={}){
  const email=`${label}-${tag}@example-test.com`,hash=hashOf(email);
  const contact=(await pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,record_class) VALUES('A','R',$1,'','production') RETURNING id`,[email])).rows[0].id;
  const op=(await pool.query(`INSERT INTO provider_operations(provider,operation_type,purpose,idempotency_key,actor_type,target_fingerprint,state,requested_units,reserved_units,billing_state,provider_usage_status)
    VALUES('zerobounce','email_validation','marketing_outreach',$1,'system',$2,'failed',1,1,'ambiguous','unknown') RETURNING id`,[`orig-${label}-${tag}`,hash])).rows[0].id;
  const hours=o.ageHours??48;
  await pool.query(`INSERT INTO provider_attempts(operation_id,attempt_number,outcome,retryable,error_code,started_at,completed_at,dispatch_marked_at)
    VALUES($1,1,'retryable_failed',true,'timeout',now()-make_interval(hours=>$2),now()-make_interval(hours=>$2),now()-make_interval(hours=>$2))`,[op,hours]);
  await pool.query(`INSERT INTO provider_observations(provider,operation_id,subject_type,subject_id,email_token_hash,outcome,retryable) VALUES('zerobounce',$1,'contact',$2,$3,'timeout',true)`,[op,contact,hash]);
  await pool.query(`INSERT INTO canonical_address_validation_claims(email_token_hash,claim_token,lease_expires_at,operation_id,dispatched_at)
    VALUES($1,gen_random_uuid(),now()-interval '1 minute',$2,now()-make_interval(hours=>$3))`,[hash,op,hours]);
  let intent:string|undefined;
  if(o.intent!==false)intent=(await pool.query(`INSERT INTO validation_intents(contact_id,normalized_email_token_hash,subject_generation,state,terminal_code,attempt_count,completed_at)
    VALUES($1,$2,1,'blocked','ambiguous_billing',1,now()) RETURNING id`,[contact,hash])).rows[0].id;
  let legacy:string|undefined;
  if(o.legacyOp){
    legacy=(await pool.query(`INSERT INTO provider_operations(provider,operation_type,purpose,idempotency_key,actor_type,target_fingerprint,state,requested_units,reserved_units,billing_state)
      VALUES('zerobounce','email_validation','marketing_outreach',$1,'system',$2,'completed',1,1,'ambiguous') RETURNING id`,[`legacy-${label}-${tag}`,hash])).rows[0].id;
    await pool.query(`INSERT INTO provider_attempts(operation_id,attempt_number,outcome,started_at,dispatch_marked_at) VALUES($1,1,'completed',now()-interval '72 hours',now()-interval '72 hours')`,[legacy]);
  }
  if(o.fresh){
    const rop=(await pool.query(`INSERT INTO provider_operations(provider,operation_type,purpose,idempotency_key,actor_type,target_fingerprint,state,requested_units,reserved_units,billing_state)
      VALUES('zerobounce','email_validation','marketing_outreach',$1,'system',$2,'completed',1,1,'committed') RETURNING id`,[`fresh-${label}-${tag}`,hash])).rows[0].id;
    await pool.query(`INSERT INTO provider_observations(provider,operation_id,subject_type,subject_id,email_token_hash,outcome,retryable,observed_at) VALUES('zerobounce',$1,'contact',$2,$3,'valid',false,now()-interval '1 day')`,[rop,contact,hash]);
  }
  return {email,hash,contact,op,intent,legacy};
}
const snapshot=async(op:string)=>JSON.stringify([
  (await pool.query(`SELECT to_jsonb(o) v FROM provider_operations o WHERE id=$1`,[op])).rows[0].v,
  (await pool.query(`SELECT to_jsonb(a) v FROM provider_attempts a WHERE operation_id=$1 ORDER BY attempt_number`,[op])).rows.map(r=>r.v),
  (await pool.query(`SELECT to_jsonb(f) v FROM provider_observations f WHERE operation_id=$1 ORDER BY id`,[op])).rows.map(r=>r.v)]);
const claim=(hash:string)=>db.transaction(tx=>addr.claimCanonicalAddressValidation(hash,tx as any));
const recovery=async(hash:string)=>(await pool.query(`SELECT * FROM zerobounce_ambiguous_recoveries WHERE email_token_hash=$1`,[hash])).rows[0];

try{
  const A=await ambiguous("a",{legacyOp:true});            // ready: old enough, plus an unsettled legacy op for the same address
  const B=await ambiguous("b",{ageHours:2});               // still inside the cooldown
  const C=await ambiguous("c",{fresh:true});               // fresh definitive receipt exists: reuse, never purchase
  const D=await ambiguous("d",{intent:false});             // no current need: out of scope
  const E=await ambiguous("e");                            // concurrency address
  const opsBefore=new Map<string,string>();
  for(const f of [A,B,C,D,E]){opsBefore.set(f.op,await snapshot(f.op));if(f.legacy)opsBefore.set(f.legacy,await snapshot(f.legacy));}

  // Before any authorization every one of them stays held.
  for(const f of [A,B,C,D,E])ok(await claim(f.hash)===null,`${f.email} is held before recovery`);

  const preview=await svc.previewAmbiguousRecovery();
  ok(preview.distinctEligibleAddresses===4,`eligible distinct addresses (A,B,C,E): ${preview.distinctEligibleAddresses}`);
  ok(preview.readyNow===2,"A and E are ready (cooldown elapsed, no fresh receipt)");
  ok(preview.cooldownPending===1,"B waits for the cooldown");
  ok(preview.freshReceiptReuse===1,"C is counted as receipt reuse, not a purchase");
  ok(preview.maxAdditionalPurchases===3,"upper bound counts one purchase for each of A, B and E only");
  ok(preview.authorizableAddresses===3,"A, C and E are authorizable now");
  ok(preview.supersededOperations>=5,"superseded operations include the legacy operation");

  // Authorization is snapshot-bound and explicit.
  await assert.rejects(()=>svc.authorizeAmbiguousRecovery({authorizationKey:`auth-${tag}-x`,expectedAuthorizableAddresses:3,expectedReadyFingerprint:"0".repeat(64),actor:"cert"}),/PREVIEW_STALE/);checks++;
  await assert.rejects(()=>svc.authorizeAmbiguousRecovery({authorizationKey:`auth-${tag}-x`,expectedAuthorizableAddresses:9,expectedReadyFingerprint:preview.readyFingerprint,actor:"cert"}),/PREVIEW_STALE/);checks++;
  ok(!(await recovery(A.hash)),"a refused authorization writes nothing");
  const authKey=`auth-${tag}-ok`;
  const auth=await svc.authorizeAmbiguousRecovery({authorizationKey:authKey,expectedAuthorizableAddresses:3,expectedReadyFingerprint:preview.readyFingerprint,actor:"cert"});
  ok(auth.authorized===3&&auth.intentsReopened===3&&auth.providerCallsMade===0,JSON.stringify(auth));
  ok(!(await recovery(B.hash))&&!(await recovery(D.hash)),"cooldown and no-need addresses are not authorized");
  const rA=await recovery(A.hash);
  ok(rA.state==="authorized"&&rA.superseded_operation_ids.includes(A.op)&&rA.superseded_operation_ids.includes(A.legacy),"A recovery names the original and legacy operations");
  ok((await pool.query(`SELECT state FROM validation_intents WHERE id=$1`,[A.intent])).rows[0].state==="pending","A's blocked intent is reopened");
  ok((await pool.query(`SELECT state FROM validation_intents WHERE id=$1`,[B.intent])).rows[0].state==="blocked","B's intent stays blocked");
  ok((await pool.query(`SELECT count(*)::int n FROM audit_logs WHERE action='zerobounce_ambiguous_recovery_authorized' AND entity_key=$1`,[authKey])).rows[0].n===1,"one audit row");
  const repeat=await svc.previewAmbiguousRecovery();
  ok(repeat.alreadyAuthorizedOrUsed===3&&repeat.distinctEligibleAddresses===1&&repeat.readyNow===0,"a second preview excludes authorized addresses");
  await assert.rejects(()=>pool.query(`INSERT INTO zerobounce_ambiguous_recoveries(email_token_hash,superseded_operation_ids,authorization_key,cooldown_until) VALUES($1,ARRAY[$2::uuid],'dup',now())`,[A.hash,A.op]));checks++;

  // B has no authorization: still held. An authorized-but-cooling recovery cannot be consumed early.
  ok(await claim(B.hash)===null,"B is still held");
  await pool.query(`INSERT INTO zerobounce_ambiguous_recoveries(email_token_hash,superseded_operation_ids,authorization_key,cooldown_until) VALUES($1,ARRAY[$2::uuid],'early',now()+interval '10 hours')`,[B.hash,B.op]);
  ok(await claim(B.hash)===null&&(await recovery(B.hash)).state==="authorized","cooldown blocks early consumption");
  await pool.query(`DELETE FROM zerobounce_ambiguous_recoveries WHERE email_token_hash=$1`,[B.hash]);

  // Single use under concurrency: two workers race for E; exactly one claim exists and the recovery is consumed once.
  const raced=await Promise.all([claim(E.hash),claim(E.hash),claim(E.hash),claim(E.hash)]);
  ok(raced.filter(Boolean).length===1,"exactly one concurrent worker obtains the recovered claim");
  const rE=await recovery(E.hash);
  const winner=raced.find(Boolean)!;
  ok(rE.state==="consumed"&&rE.consumed_claim_token===winner.claimToken,"recovery consumed by the winning claim");

  // The additional attempt gets its own operation identity; the original rows are untouched.
  const newOp=(await pool.query(`INSERT INTO provider_operations(provider,operation_type,purpose,idempotency_key,actor_type,target_fingerprint,state,requested_units,reserved_units,billing_state)
    VALUES('zerobounce','email_validation','marketing_outreach',$1,'system',$2,'running',1,1,'reserved') RETURNING id`,[`new-e-${tag}`,E.hash])).rows[0].id;
  ok(newOp!==E.op,"distinct operation identity");
  await addr.bindCanonicalAddressOperation(winner,newOp);
  ok((await recovery(E.hash)).new_operation_id===newOp,"recovery records the new operation");
  ok(await snapshot(E.op)===opsBefore.get(E.op),"original operation, attempts and observations are unchanged (billing facts preserved)");

  // A second uncertainty on the additional attempt stays held: no further recovery can be authorized.
  await db.transaction(async tx=>addr.markCanonicalAddressDispatch(winner,newOp,tx as any));
  await pool.query(`INSERT INTO provider_attempts(operation_id,attempt_number,outcome,started_at,dispatch_marked_at) VALUES($1,1,'ambiguous',now(),now())`,[newOp]);
  await pool.query(`UPDATE canonical_address_validation_claims SET lease_expires_at=now()-interval '1 minute' WHERE email_token_hash=$1`,[E.hash]);
  await pool.query(`UPDATE provider_operations SET state='failed',provider_usage_status='unknown' WHERE id=$1`,[newOp]);
  ok(await claim(E.hash)===null,"second uncertainty keeps the address held");
  const afterSecond=await svc.previewAmbiguousRecovery();
  ok(afterSecond.distinctEligibleAddresses===1&&afterSecond.readyNow===0,"the used recovery is never offered again");
  ok(await claim(E.hash)===null,"repeated claims remain refused");

  // A: the superseded legacy operation no longer blocks; the claim is obtained once.
  const a1=await claim(A.hash);ok(a1!==null,"A claim obtained after recovery despite the legacy operation");
  ok(await claim(A.hash)===null,"A cannot be claimed twice");
  ok(await snapshot(A.op)===opsBefore.get(A.op)&&await snapshot(A.legacy!)===opsBefore.get(A.legacy!),"A original rows unchanged");
  // C: lifting the claim lets the ordinary path find the fresh receipt (no purchase).
  const c1=await claim(C.hash);ok(c1!==null,"C claim is released for receipt reuse");
  const freshHit=(await pool.query(`SELECT 1 FROM provider_observations WHERE email_token_hash=$1 AND retryable=false AND outcome IN ('valid','invalid') AND observed_at>now()-interval '30 days'`,[C.hash])).rows.length;
  ok(freshHit===1,"C has a fresh definitive receipt available to the ordinary reuse path");
  ok(await claim(D.hash)===null,"D without authorization remains held");
  ok(getBlockedCertificationNetworkAttemptCount()===0,"no provider network attempt was made");
  console.log(`ZeroBounce ambiguous recovery: ${checks} checks passed; fake data only; zero provider calls`);
}finally{await pool.end();}
