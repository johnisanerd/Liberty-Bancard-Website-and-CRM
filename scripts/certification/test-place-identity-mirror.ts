import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {sql} from "drizzle-orm";
import {assertDisposableTestInfrastructure} from "../test-infrastructure-guard";
await assertDisposableTestInfrastructure({operation:"place-identity-mirror-concurrency",requireRedis:false});
const {db,pool}=await import("../../server/db");
const {mirrorEstablishedPlaceIdentities:batch,mirrorEstablishedPlaceIdentity:single,resolveOrganization}=await import("../../server/services/organization-resolver");
const {normalOrganizationName}=await import("../../server/services/organization-resolution-policy");
let checks=0;
const key=()=>`ChIJ${randomUUID()}`;
async function business(place:string|null=null){
  const name=`Mirror ${randomUUID()}`;
  const r=await pool.query(`INSERT INTO businesses(canonical_name,normalized_name,record_class,google_place_id)
    VALUES($1,$2,'canonical',$3) RETURNING id,canonical_name`,[name,normalOrganizationName(name),place]);
  return r.rows[0];
}
async function link(id:number,place:string,namespace="outscraper"){
  return (await pool.query(`INSERT INTO canonical_source_links(business_id,source_system,source_type,stable_key,raw_evidence)
    VALUES($1,$2,'place',$3,'{}') RETURNING id`,[id,namespace,place])).rows[0].id;
}
async function value(id:number){
  return (await pool.query("SELECT google_place_id FROM businesses WHERE id=$1",[id])).rows[0].google_place_id;
}
function latch(){
  let release!:()=>void;
  const promise=new Promise<void>(r=>{release=r;});
  return {promise,release};
}
async function waitOnPlaceLock(pid:number){
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){
    const r=await pool.query("SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1",[pid]);
    if(r.rows[0]?.wait_event_type==="Lock" && r.rows[0]?.wait_event==="advisory")return;
    await new Promise(r=>setTimeout(r,10));
  }
  throw new Error("EXPECTED_ADVISORY_LOCK_WAIT");
}
try{
  for(const [a,b] of [["outscraper","google_maps"],["google","outscraper"],["google_maps","google"]]){
    const place=key(),one=await business(),two=await business();
    await link(one.id,place,a);await link(two.id,place,b);
    assert.equal(await db.transaction(tx=>single(tx,one.id,place)),null);checks++;
    assert.deepEqual(await db.transaction(tx=>batch(tx)),[]);checks++;
    assert.equal(await value(one.id),null);assert.equal(await value(two.id),null);checks+=2;
    const resolved=await resolveOrganization({canonicalName:one.canonical_name,googlePlaceId:place});
    assert.equal(resolved.kind,"deferred");checks++;
  }
  // Same owner in different namespaces is not an ownership conflict.
  const place=key(),one=await business();
  const ids=[await link(one.id,place),await link(one.id,place,"google")].sort();
  const receipts=await db.transaction(tx=>batch(tx));
  assert.deepEqual(receipts,[{businessId:one.id,placeId:place,sourceLinkIds:ids}]);checks++;
  assert.deepEqual(await db.transaction(tx=>batch(tx)),[]);checks++;
  // Multiple distinct places on one business must not be collapsed.
  const multi=await business(),mkey=key();await link(multi.id,mkey);await link(multi.id,key(),"google");
  assert.equal(await db.transaction(tx=>single(tx,multi.id,mkey)),null);checks++;

  // Resolver holds place lock first; mirror blocks and rechecks a committed owner.
  {
    const place=key(),target=await business(),locked=latch(),finish=latch(),started=latch();
    let pid=0;
    const writer=db.transaction(async tx=>{
      const r=await resolveOrganization({canonicalName:`Fresh ${randomUUID()}`,googlePlaceId:place,
        create:{recordClass:"canonical"},transaction:tx});
      assert.equal(r.kind,"created");
      locked.release();await finish.promise;
    });
    await locked.promise;
    // A retained source link arrives while the resolver's root is uncommitted.
    // Candidate selection cannot see that root; the fresh post-lock check must.
    await link(target.id,place);
    const mirror=db.transaction(async tx=>{
      pid=(await tx.execute(sql`SELECT pg_backend_pid() pid`)).rows[0].pid as number;
      started.release();return batch(tx);
    });
    try{await started.promise;await waitOnPlaceLock(pid);checks++;}finally{finish.release();}
    await writer;
    assert.deepEqual(await mirror,[]);assert.equal(await value(target.id),null);checks+=2;
  }
  // Mirror holds the place lock first; real resolver blocks, then matches same root.
  {
    const place=key(),target=await business(),locked=latch(),finish=latch(),started=latch();
    await link(target.id,place);let pid=0;
    const mirror=db.transaction(async tx=>{
      const r=await batch(tx);assert(r.some(x=>x.businessId===target.id));locked.release();await finish.promise;
    });
    await locked.promise;
    const resolver=db.transaction(async tx=>{
      pid=(await tx.execute(sql`SELECT pg_backend_pid() pid`)).rows[0].pid as number;started.release();
      return resolveOrganization({canonicalName:target.canonical_name,googlePlaceId:place,transaction:tx});
    });
    try{await started.promise;await waitOnPlaceLock(pid);checks++;}finally{finish.release();}
    await mirror;
    const r=await resolver;assert.equal(r.kind,"matched");
    if(r.kind==="matched")assert.equal(r.business.id,target.id);
    assert.equal(await value(target.id),place);checks+=3;
  }
  // Competing single/batch mirrors serialize, with exactly one receipt.
  {
    const place=key(),target=await business();await link(target.id,place);
    const [a,b]=await Promise.all([db.transaction(tx=>single(tx,target.id,place)),db.transaction(tx=>batch(tx))]);
    assert.equal((a ? 1 : 0)+b.filter(x=>x.businessId===target.id).length,1);checks++;
  }
  console.log(`Place identity ownership/concurrency: ${checks} PostgreSQL checks passed`);
}finally{await pool.end();}
