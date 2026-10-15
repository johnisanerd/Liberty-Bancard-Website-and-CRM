import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import {writeFileSync} from "node:fs";
import pg from "pg";
import {assertDisposableTestInfrastructure} from "../test-infrastructure-guard";
import {applyCertificationProviderDenyBoundary,getBlockedCertificationNetworkAttemptCount} from "../certification-provider-deny";

const certificationEnvironment=Object.freeze({...process.env});
await assertDisposableTestInfrastructure({operation:"retained canonical recovery",requireRedis:false,
  env:certificationEnvironment});
applyCertificationProviderDenyBoundary({fatal:true});
process.env.NODE_ENV="production";process.env.REPLIT_DEPLOYMENT="1";
// Install before the app instruments physical clients. Its per-connection
// observer saves query methods, so changing the prototype later misses cached
// pooled clients and would NOT actually simulate lost commit acknowledgements.
const originalQuery=pg.Client.prototype.query;
let afterCommit:(()=>Promise<void>)|null=null;
(pg.Client.prototype.query as any)=function(...args:any[]){
  const response=(originalQuery as any).apply(this,args);
  const text=typeof args[0]==="string" ? args[0] : args[0]?.text;
  if(!response?.then || !/\bCOMMIT\b/i.test(text ?? ""))return response;
  return response.then(async(value:any)=>{await afterCommit?.();return value;});
};
const {pool,db}=await import("../../server/db");
const {sql}=await import("drizzle-orm");
const {claimSfpRuntimeDeploymentOwner,renewSfpRuntimeDeploymentOwner}=await import("../../server/services/cro03/sfp-provider-operations");
const {processCanonicalImportRecoveryTick,canonicalImportRecoveryClaimSql}=await import("../../server/services/canonical-import-recovery-worker");
const {providerImportEmails,materializeCanonicalProviderImportRow}=await import("../../server/services/canonical-provider-import");
const {LADDER_BUDGET_LOCK_KEY}=await import("../../server/services/cro03/shared-paid-budget-ledger");
const {CanonicalImportRecoveryFailure}=await import("../../server/services/canonical-import-recovery-outcomes");
const {CANONICAL_IMPORT_FULFILLMENT_QUALIFICATION_VERSION}=await import("../../server/services/canonical-import-recovery-contract");
const {claimCsvExecution,completeImportExecution}=await import("../../server/services/import-execution");
const {inputRows,seedExecution,syntheticRows,dispatchStoppedAfterBudget}=await import("./retained-recovery-fixtures");
const {seedNativeRetainedTopology,retainedNativeExecutionId,verifyRetainedBusinessRelationships}=await import("./retained-native-topology");
const phase=process.argv[2];
const probe=new pg.Client({connectionString:process.env.DATABASE_URL});await probe.connect();
let checks=0;
const check=(value:unknown,label:string)=>{assert(value,label);checks++;console.log(`PASS ${label}`);};
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const items=async(execution:string)=>(await probe.query(`SELECT item.*,split_part(batch.idempotency_key,':',3)::int row_number,
  EXISTS(SELECT 1 FROM audit_logs receipt WHERE receipt.entity_type='cro03_enrichment_item'
    AND receipt.entity_key=item.id::text AND receipt.action='canonical_import_row_fulfilled'
    AND receipt.details->>'qualificationVersion'=$2) qualified
  FROM cro03_enrichment_items item JOIN cro03_enrichment_batches batch ON batch.id=item.batch_id
  WHERE batch.idempotency_key LIKE $1 ORDER BY row_number`,
  [`csv-source:${execution}:%`,CANONICAL_IMPORT_FULFILLMENT_QUALIFICATION_VERSION])).rows;
const executions=async(kind:string)=>kind==="retained_original"
  ? (await probe.query("SELECT id,metadata FROM import_executions WHERE id=$1",
    [retainedNativeExecutionId()])).rows
  : (await probe.query("SELECT id,metadata FROM import_executions WHERE metadata->>'certificationKind'=$1",[kind])).rows;
const baseline=async()=>(await probe.query(`SELECT
  (SELECT count(*)::int FROM contacts) contacts,(SELECT count(*)::int FROM businesses) businesses,
  (SELECT count(*)::int FROM contact_source_events) provenance,
  (SELECT count(*)::int FROM provider_operations) provider_operations,
  (SELECT count(*)::int FROM communication_events) communications,
  (SELECT count(*)::int FROM validation_intents) validation_intents`)).rows[0];
const safetyBefore=await baseline();
const diagnostics:string[]=[];
const originalWarn=console.warn;
console.warn=(...args:any[])=>{diagnostics.push(args.join(" "));originalWarn(...args);};
let status=0;
try {
  if(phase==="partial_accounting"){
    const fixtures=syntheticRows(5);
    fixtures.forEach((row,index)=>{
      row.disposition=index===1?"matched_noop":"created";
      row.reasonCode="CANONICAL_PROVIDER_CONTACT_CREATED";
    });
    fixtures[0].rawRow.address="10 Recovery Fixture Road";
    fixtures[0].rawRow.phone="+1 (305) 555-0199";
    fixtures[0].rowFingerprint=createHash("sha256").update(JSON.stringify(fixtures[0].rawRow)).digest("hex");
    const {resolveOrganization}=await import("../../server/services/organization-resolver");
    const phoneBusiness=await resolveOrganization({canonicalName:fixtures[0].rawRow.name,
      googlePlaceId:fixtures[0].rawRow.place_id,mainPhone:"3055550199",city:"Miami",state:"FL",
      streetAddress:fixtures[0].rawRow.address,create:{recordClass:"canonical"}});
    if(phoneBusiness.kind==="deferred")throw Error("EXPECTED_NATIVE_PHONE_BUSINESS");
    const target=await seedExecution(fixtures,"partial_accounting");
    const seeded=await items(target);
    for(let index=0;index<seeded.length;index++){
      await probe.query(`UPDATE cro03_enrichment_items SET terminal_code='CANONICAL_IMPORT_CONTACT_AFFILIATION_HELD',
        state='blocked',next_attempt_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,[seeded[index].id]);
      if(index===2)continue; // Created accounting without a versioned hold is not recovery authority.
      const details={holdEvidenceVersion:"native_revision_bound_v1",executionId:target,
        sourceRowNumber:index+1,rowFingerprint:index===3?"wrong":fixtures[index].rowFingerprint};
      await probe.query(`INSERT INTO audit_logs(action,entity_type,entity_key,details,actor_type,actor_id)
        VALUES('canonical_import_hold_evidence','cro03_enrichment_item',$1,$2::jsonb,'system','fixture')`,
        [seeded[index].id,JSON.stringify(details)]);
    }
    // The first mailbox already exists; recovery must reuse it rather than
    // treating its created accounting as full original-row fulfillment.
    const firstContact=(await probe.query(`INSERT INTO contacts(first_name,last_name,email,phone,company_name,address,
      city,state,record_class) VALUES('Partial','Mailbox',$1,'',$2,$3,'Miami','FL','production') RETURNING id`,
      [fixtures[0].rawRow.email_1,fixtures[0].rawRow.name,fixtures[0].rawRow.address])).rows[0].id;
    // An unsupported terminal code cannot gain authority from a hold receipt.
    await probe.query(`UPDATE cro03_enrichment_items SET terminal_code='NOT_A_SUPPORTED_HOLD' WHERE id=$1`,
      [seeded[4].id]);
    const beforeAccounting=(await probe.query("SELECT * FROM import_row_dispositions WHERE execution_id=$1 ORDER BY source_row_number",[target])).rows;
    const first=await processCanonicalImportRecoveryTick({maxItems:2});
    if(first.fulfilled!==2)console.log("PARTIAL_ACCOUNTING_DIAGNOSTIC",JSON.stringify((await probe.query(
      `SELECT a.details->>'reasonCode' reason,a.details->'diagnostic'->'affiliationOutcomes' outcomes,
      a.details->'diagnostic'->'nativeSnapshots' snapshots FROM audit_logs a
      WHERE a.action='canonical_import_hold_evidence' AND a.details->>'executionId'=$1 ORDER BY a.id DESC LIMIT 3`,
      [target])).rows));
    check(first.fulfilled===2 && first.failed===0,"Ordinary recovery completes created and matched partial receipts without explicit replay");
    const after=await items(target);
    check(after[0].qualified && after[1].qualified,"Both partial rows receive current original-row qualification");
    check(after.slice(2).every(row=>row.state==="blocked" && row.attempt_count===0),
      "Unproven, wrong-fingerprint and unsupported holds are never claimed");
    const firstMailbox=(await probe.query("SELECT id,business_id FROM contacts WHERE email=$1",
      [fixtures[0].rawRow.email_1])).rows;
    check(firstMailbox.length===1 && firstMailbox[0].id===firstContact,
      "Existing first mailbox is reused");
    check(firstMailbox[0].business_id===phoneBusiness.business.id,
      "Original-row recovery resolves US country-code formatting against the existing business");
    check((await probe.query(`SELECT count(*)::int n FROM contact_source_events
      WHERE import_execution_id=$1 AND source_row_number=1`,[target])).rows[0].n===3,
      "All retained mailboxes have original provenance");
    assert.deepEqual((await probe.query("SELECT * FROM import_row_dispositions WHERE execution_id=$1 ORDER BY source_row_number",[target])).rows,beforeAccounting);
    check(true,"Historical created/matched accounting is immutable");
    const protectedRow=syntheticRows(1)[0];
    protectedRow.rawRow.email_1=fixtures[0].rawRow.email_1;
    protectedRow.rowFingerprint=createHash("sha256").update(JSON.stringify(protectedRow.rawRow)).digest("hex");
    protectedRow.disposition="created";
    const protectedExecution=await seedExecution([protectedRow],"partial_accounting_protected");
    const protectedItem=(await items(protectedExecution))[0];
    const originalBusiness=(await probe.query("SELECT business_id FROM contacts WHERE id=$1",[firstContact])).rows[0].business_id;
    await probe.query(`INSERT INTO contact_source_events(contact_id,event_key,source_category,source_type,
      import_execution_id,source_row_number,row_fingerprint,actor_type,metadata)
      VALUES($1,$2,'csv_import','outscraper',$3,1,$4,'import','{}'::jsonb)`,
      [firstContact,`canonical-provider:${protectedExecution}:1:${createHash("sha256").update(protectedRow.rawRow.email_1).digest("hex")}`,
        protectedExecution,protectedRow.rowFingerprint]);
    await probe.query(`UPDATE cro03_enrichment_items SET terminal_code='CANONICAL_IMPORT_CONTACT_AFFILIATION_HELD',
      state='blocked',next_attempt_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,[protectedItem.id]);
    await probe.query(`INSERT INTO audit_logs(action,entity_type,entity_key,details,actor_type,actor_id)
      VALUES('canonical_import_hold_evidence','cro03_enrichment_item',$1,$2::jsonb,'system','fixture')`,
      [protectedItem.id,JSON.stringify({holdEvidenceVersion:"native_revision_bound_v1",
        executionId:protectedExecution,sourceRowNumber:1,rowFingerprint:protectedRow.rowFingerprint})]);
    const protectedAccounting=(await probe.query("SELECT * FROM import_row_dispositions WHERE execution_id=$1",[protectedExecution])).rows;
    const held=await processCanonicalImportRecoveryTick({maxItems:1});
    check(held.held===1 && held.fulfilled===0 && held.failed===0,
      "A recoverable created receipt with a genuine foreign affiliation remains held");
    check((await probe.query("SELECT business_id FROM contacts WHERE id=$1",[firstContact])).rows[0].business_id===originalBusiness,
      "Partial recovery cannot transfer an existing verified mailbox");
    check(!(await items(protectedExecution))[0].qualified,"A genuine hold gets no fulfillment receipt");
    assert.deepEqual((await probe.query("SELECT * FROM import_row_dispositions WHERE execution_id=$1",[protectedExecution])).rows,protectedAccounting);
    const before=await baseline();
    const again=await processCanonicalImportRecoveryTick({maxItems:2});
    check(again.attempted===0,"Qualified partial rows are not reselected");
    assert.deepEqual(await baseline(),before);
    check(getBlockedCertificationNetworkAttemptCount()===0,"Partial recovery performs no provider I/O");
  } else if(phase==="scoped_replay"){
    const target=await seedExecution(syntheticRows(2),"scoped_replay_target");
    const unrelated=await seedExecution(syntheticRows(1),"scoped_replay_unrelated");
    const immutable=(await probe.query("SELECT source_row_number,disposition,reason_code,row_fingerprint FROM import_row_dispositions WHERE execution_id=$1 ORDER BY source_row_number",[target])).rows;
    const first=await processCanonicalImportRecoveryTick({maxItems:1,
      replay:{executionId:target,sourceRowNumbers:[1,2]}});
    assert.equal(first.fulfilled,1);
    assert.deepEqual(first.replay?.remainingSourceRowNumbers,[2]);
    assert.equal(first.replay?.scopeAttempted,false);
    check(true,"Bounded replay reports the exact unattempted original coordinates");
    const second=await processCanonicalImportRecoveryTick({maxItems:1,
      replay:{executionId:target,sourceRowNumbers:[2]}});
    assert.equal(second.fulfilled,1);
    assert.equal(second.replay?.scopeAttempted,true);
    const before=await baseline();
    const targetBefore=await items(target),unrelatedBefore=await items(unrelated);
    assert(targetBefore.every(item=>item.state==="completed" && item.qualified));
    const ordinary=(await db.execute(canonicalImportRecoveryClaimSql()) as any).rows;
    assert(!ordinary.some((row:any)=>row.execution_id===target));
    check(true,"Ordinary scheduling still excludes current-qualified completions");
    const replay=await processCanonicalImportRecoveryTick({maxItems:2,
      replay:{executionId:target,sourceRowNumbers:[1,2]}});
    assert.equal(replay.fulfilled,2);
    assert.equal(replay.replay?.scopeAttempted,true);
    assert.deepEqual(replay.replay?.rowOutcomes.map(row=>row.sourceRowNumber).sort(),[1,2]);
    assert.deepEqual(await baseline(),before);
    assert.deepEqual((await probe.query("SELECT source_row_number,disposition,reason_code,row_fingerprint FROM import_row_dispositions WHERE execution_id=$1 ORDER BY source_row_number",[target])).rows,immutable);
    assert.deepEqual(await items(unrelated),unrelatedBefore);
    const targetAfter=await items(target);
    for(let index=0;index<targetBefore.length;index++) {
      assert.equal(targetAfter[index].execution_fence,targetBefore[index].execution_fence+1);
      assert.equal(targetAfter[index].attempt_count,targetBefore[index].attempt_count+1);
    }
    check(true,"Current-qualified originals replay through normal new claims without resetting items, changing accounting or duplicating graph/provenance");
    check(true,"Source-scoped replay never claims the unrelated execution");
    const rejectedScopes=[
      {executionId:"not-a-uuid",sourceRowNumbers:[1]},
      {executionId:target,sourceRowNumbers:[]},
      {executionId:target,sourceRowNumbers:[0]},
      {executionId:target,sourceRowNumbers:[1,1]},
      {executionId:target,sourceRowNumbers:[Number.MAX_SAFE_INTEGER+1]},
      {executionId:target,sourceRowNumbers:[2_147_483_648]},
      {executionId:target,sourceRowNumbers:Array.from({length:251},(_,i)=>i+1)},
    ];
    for(const replay of rejectedScopes)
      await assert.rejects(()=>processCanonicalImportRecoveryTick({replay}),/REPLAY_INVALID_SCOPE/);
    check(true,"Malformed, duplicate, unsafe and oversized replay scopes fail before native claims");
    const heldRows=syntheticRows(1);
    delete heldRows[0].rawRow.name;
    heldRows[0].rowFingerprint=createHash("sha256").update(JSON.stringify(heldRows[0].rawRow)).digest("hex");
    const heldExecution=await seedExecution(heldRows,"scoped_replay_hold");
    const heldFirst=await processCanonicalImportRecoveryTick({maxItems:1,
      replay:{executionId:heldExecution,sourceRowNumbers:[1]}});
    assert.equal(heldFirst.held,1);
    const heldBefore=(await items(heldExecution))[0];
    assert(new Date(heldBefore.next_attempt_at).getTime()>Date.now());
    const heldReplay=await processCanonicalImportRecoveryTick({maxItems:1,
      replay:{executionId:heldExecution,sourceRowNumbers:[1]}});
    assert.equal(heldReplay.held,1);
    const heldAfter=(await items(heldExecution))[0];
    assert.equal(heldAfter.terminal_code,heldBefore.terminal_code);
    assert.equal(heldAfter.execution_fence,heldBefore.execution_fence+1);
    check(true,"Future-scheduled holds are genuinely re-evaluated and remain held, never forced into fulfillment");
    const busy=targetAfter[0],token=randomUUID();
    await probe.query(`UPDATE cro03_enrichment_items SET state='running',current_provider='canonical_local_import',
      claim_token=$2::uuid,lease_expires_at=clock_timestamp()+interval '10 minutes' WHERE id=$1`,
      [busy.id,token]);
    const busyBefore=(await items(target))[0];
    const denied=await processCanonicalImportRecoveryTick({maxItems:1,
      replay:{executionId:target,sourceRowNumbers:[1]}});
    assert.equal(denied.attempted,0);
    assert.equal(denied.replay?.scopeAttempted,false);
    assert.deepEqual(denied.replay?.remainingSourceRowNumbers,[1]);
    assert.deepEqual((await items(target))[0],busyBefore);
    check(true,"Explicit replay cannot take or reset another live claim and reports the incomplete scope");
    // Exercise the actual HTTP boundary with a real local-auth session and
    // double-submit CSRF cookies, not a mocked principal or direct handler call.
    const {default:express}=await import("express");
    const {default:cookieParser}=await import("cookie-parser");
    const {default:bcrypt}=await import("bcryptjs");
    const {users}=await import("../../shared/schema");
    const {setupAuth,registerAuthRoutes}=await import("../../server/replit_integrations/auth");
    const {csrfTokenEndpoint}=await import("../../server/middleware/csrf");
    const {registerImportsRoutes}=await import("../../server/routes/imports");
    const fixtureUserId=randomUUID(),fixtureEmail=`replay-http-${fixtureUserId}@example.test`;
    const fixturePassword=`fixture-only-${randomUUID()}`;
    await db.insert(users).values({id:fixtureUserId,email:fixtureEmail,role:"admin",
      passwordHash:await bcrypt.hash(fixturePassword,10),authProvider:"local",emailVerified:new Date()});
    const app=express();app.use(express.json());app.use(cookieParser());
    await setupAuth(app);registerAuthRoutes(app);
    app.get("/api/csrf-token",csrfTokenEndpoint);registerImportsRoutes(app);
    const server=app.listen(0,"127.0.0.1");
    await new Promise<void>((resolve,reject)=>{server.once("listening",resolve);server.once("error",reject);});
    try {
      const address=server.address();assert(address && typeof address!=="string");
      const origin=`http://127.0.0.1:${address.port}`;
      const login=await fetch(`${origin}/api/auth/login`,{method:"POST",
        headers:{"content-type":"application/json","x-forwarded-proto":"https"},
        body:JSON.stringify({email:fixtureEmail,password:fixturePassword})});
      assert.equal(login.status,200,"Real fixture admin sign-in must succeed");
      const cookie=login.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");
      assert(cookie);
      const csrf=await fetch(`${origin}/api/csrf-token`,
        {headers:{cookie,"x-forwarded-proto":"https"}});
      assert.equal(csrf.status,200);
      const {token:csrfToken}=await csrf.json() as {token:string};assert(csrfToken);
      const csrfCookie=csrf.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");
      const httpBefore=await baseline(),httpRowsBefore=await items(target);
      const response=await fetch(`${origin}/api/import-executions/${target}/replay-retained`,{
        method:"POST",headers:{"content-type":"application/json","x-forwarded-proto":"https",
          cookie:[cookie,csrfCookie].filter(Boolean).join("; "),"x-csrf-token":csrfToken},
        body:JSON.stringify({sourceRowNumbers:[2]})});
      assert.equal(response.status,200,"Authenticated retained replay must reach normal native fulfillment");
      const body=await response.json() as Awaited<ReturnType<typeof processCanonicalImportRecoveryTick>>;
      assert.equal(body.fulfilled,1);assert.equal(body.replay?.scopeAttempted,true);
      assert.deepEqual(body.replay?.rowOutcomes.map(row=>row.sourceRowNumber),[2]);
      assert.deepEqual(await baseline(),httpBefore);
      const httpRowsAfter=await items(target);
      assert.deepEqual(httpRowsAfter[0],httpRowsBefore[0]);
      assert.equal(httpRowsAfter[1].execution_fence,httpRowsBefore[1].execution_fence+1);
      const requests=(await probe.query(`SELECT actor_id,details FROM audit_logs
        WHERE action='canonical_import_replay_requested' AND entity_key=$1`,[target])).rows;
      assert(requests.some(row=>row.actor_id===fixtureUserId &&
        JSON.stringify(row.details.sourceRowNumbers)==="[2]" && row.details.selectionOnly===true));
      check(true,"Real authenticated CSRF-protected HTTP replay fulfills only the requested original row and records its requesting actor");
    }finally {
      await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    }
  } else if(phase==="staging_disabled_created"){
    // Created/matched originals whose item never left STAGING_RECIPE_DISABLED
    // and which carry NO hold evidence (the production shape of the upload gap).
    const rehash=(row:any)=>{row.rowFingerprint=createHash("sha256").update(JSON.stringify(row.rawRow)).digest("hex");};
    const fixtures=syntheticRows(4);
    fixtures.forEach((row,index)=>{
      row.disposition=index===1?"matched_noop":"created";
      row.reasonCode="CANONICAL_PROVIDER_CONTACT_CREATED";
    });
    for(const key of ["email_1","email_2","additional_emails"])delete fixtures[2].rawRow[key];
    fixtures[2].reasonCode="CANONICAL_PROVIDER_BUSINESS_ONLY";
    fixtures.forEach(rehash);
    // An existing record with independent address/phone corroboration is reused.
    fixtures[3].rawRow.address="20 Reuse Fixture Road";fixtures[3].rawRow.phone="+1 (305) 555-0188";
    rehash(fixtures[3]);
    const {resolveOrganization}=await import("../../server/services/organization-resolver");
    const phoneBusiness=await resolveOrganization({canonicalName:fixtures[3].rawRow.name,
      googlePlaceId:fixtures[3].rawRow.place_id,mainPhone:"3055550188",city:"Miami",state:"FL",
      streetAddress:fixtures[3].rawRow.address,create:{recordClass:"canonical"}});
    if(phoneBusiness.kind==="deferred")throw Error("EXPECTED_NATIVE_REUSE_BUSINESS");
    const reused=(await probe.query(`INSERT INTO contacts(first_name,last_name,email,phone,company_name,address,
      city,state,record_class) VALUES('Reuse','Mailbox',$1,'',$2,$3,'Miami','FL','production') RETURNING id`,
      [fixtures[3].rawRow.email_1,fixtures[3].rawRow.name,fixtures[3].rawRow.address])).rows[0].id;
    const target=await seedExecution(fixtures,"staging_disabled_created");
    const seeded=await items(target);
    check(seeded.every(row=>row.state==="blocked" && row.terminal_code==="STAGING_RECIPE_DISABLED"),
      "Fixture reproduces the production shape: created/matched originals blocked as STAGING_RECIPE_DISABLED");
    const holdEvidence=async(execution:string)=>(await probe.query(`SELECT count(*)::int n FROM audit_logs
      WHERE action='canonical_import_hold_evidence' AND details->>'executionId'=$1`,[execution])).rows[0].n;
    check(await holdEvidence(target)===0,"No hold evidence exists for the created/matched originals");
    const accountingOf=async(execution:string)=>(await probe.query(
      "SELECT * FROM import_row_dispositions WHERE execution_id=$1 ORDER BY source_row_number",[execution])).rows;
    const accountingBefore=await accountingOf(target);

    // Selection, claim verification and renewal are proven separately.
    const selectable=(await db.execute(canonicalImportRecoveryClaimSql()) as any).rows;
    check(selectable.length===1 && selectable[0].execution_id===target,
      "Selection admits a created original blocked as STAGING_RECIPE_DISABLED without hold evidence");
    const probeItem=seeded[0],probeToken=randomUUID();
    await probe.query(`UPDATE cro03_enrichment_items SET state='running',current_provider='canonical_local_import',
      claim_token=$2::uuid,lease_expires_at=clock_timestamp()+interval '10 minutes' WHERE id=$1`,[probeItem.id,probeToken]);
    const {hasCanonicalImportRecoveryClaim}=await import("../../server/services/canonical-import-recovery-contract");
    const claimInput={executionId:target,sourceRowNumber:1,rowFingerprint:fixtures[0].rowFingerprint,
      recoveryClaim:{itemId:probeItem.id,claimToken:probeToken}};
    check(await db.transaction(tx=>hasCanonicalImportRecoveryClaim(tx,claimInput)),
      "Claim verification accepts the live claim over a created original without hold evidence");
    check(await db.transaction(tx=>hasCanonicalImportRecoveryClaim(tx,{...claimInput,renew:true})),
      "Renewal extends only that live claim");
    check(!await db.transaction(tx=>hasCanonicalImportRecoveryClaim(tx,{...claimInput,
      recoveryClaim:{itemId:probeItem.id,claimToken:randomUUID()}})),"A replaced token is never accepted");
    check(!await db.transaction(tx=>hasCanonicalImportRecoveryClaim(tx,{...claimInput,rowFingerprint:"0".repeat(64)})),
      "A different row fingerprint is never accepted");
    await probe.query(`UPDATE cro03_enrichment_items SET state='blocked',current_provider=NULL,claim_token=NULL,
      lease_expires_at=NULL WHERE id=$1`,[probeItem.id]);

    const result=await processCanonicalImportRecoveryTick({maxItems:4});
    check(result.fulfilled===4 && result.failed===0 && result.held===0,
      "The ordinary worker fulfills created, matched, business-only and existing-record originals");
    const after=await items(target);
    check(after.every(row=>row.state==="completed" && row.qualified),"Every original item receives a current-qualification receipt");
    const emails=(row:any)=>providerImportEmails(row.rawRow);
    const contactsByRow=async(execution:string,row:number)=>(await probe.query(`SELECT DISTINCT contact.id,contact.email,contact.business_id
      FROM contact_source_events event JOIN contacts contact ON contact.id=event.contact_id
      WHERE event.import_execution_id=$1 AND event.source_row_number=$2 ORDER BY contact.email`,[execution,row])).rows;
    for(const index of [0,1,3]) {
      const linked=await contactsByRow(target,index+1);
      assert.deepEqual(linked.map(c=>c.email),emails(fixtures[index]).sort());
      assert(linked.every(c=>c.business_id!=null && c.business_id===linked[0].business_id));
    }
    check(true,"Every retained mailbox has provenance and one verified business link");
    check((await contactsByRow(target,4)).some(c=>c.id===reused) &&
      (await probe.query("SELECT count(*)::int n FROM contacts WHERE email=$1",[fixtures[3].rawRow.email_1])).rows[0].n===1,
      "An existing record is reused, never duplicated");
    check((await contactsByRow(target,1)).length===3,"Multiple mailboxes on one original row all materialize");
    check((await probe.query(`SELECT count(*)::int n FROM contact_source_events
      WHERE import_execution_id=$1 AND source_row_number=3`,[target])).rows[0].n===0,
      "A business-only original creates no placeholder contact or provenance");
    check((await probe.query(`SELECT count(*)::int n FROM businesses WHERE canonical_name=$1`,
      [fixtures[2].rawRow.name])).rows[0].n===1,"A business-only original still materializes its business");
    assert.deepEqual(await accountingOf(target),accountingBefore);
    check(await holdEvidence(target)===0,"Immutable accounting and hold evidence are unchanged by fulfillment");
    // Paginated original-coordinate ledger: every coordinate, stable keyset, bounded evidence.
    const ledger=await import("../../server/services/canonical-upload-ledger");
    const page1=await ledger.readUploadLedgerPage({executionId:target,limit:2});
    const page2=await ledger.readUploadLedgerPage({executionId:target,after:page1.nextAfter,limit:2});
    const allRows=[...page1.rows,...page2.rows];
    check(page1.nextAfter===2 && page2.nextAfter===null &&
      allRows.map(row=>row.sourceRowNumber).join()==="1,2,3,4","The ledger pages every original coordinate in stable order without gaps or repeats");
    const again=await ledger.readUploadLedgerPage({executionId:target,limit:2});
    assert.deepEqual(again.rows,page1.rows);
    check(allRows.every(row=>/^raw-v[23]$/.test(String(row.originalFormat))),"The ledger recognizes the retained raw-v2/v3 original of every row");
    check(allRows[0].mailboxes.length===3 && allRows[0].mailboxes.every(m=>m.hasProvenance && m.verifiedLink),
      "The ledger shows every mailbox of a multi-mailbox row with its verified link");
    check(allRows[2].businessOnly && allRows[2].mailboxes.length===0 && allRows[2].receipt.status==="current",
      "The ledger shows a business-only row without inventing a mailbox");
    check(allRows.every(row=>row.receipt.status==="current"),"Receipts validate against coordinate, fingerprint and qualification version");
    const summary=await ledger.readUploadLedgerSummary(target);
    check(summary.rows===4 && summary.receiptsCurrent===4 && summary.receiptsStale===0 && summary.receiptsInconsistent===0 &&
      summary.distinctContacts===(await probe.query(`SELECT count(DISTINCT contact_id)::int n FROM contact_source_events
        WHERE import_execution_id=$1`,[target])).rows[0].n && summary.verifiedLinks===summary.distinctContacts,
      "Rows, distinct contacts, verified links and receipts are reported separately");
    const unfulfilledNow=await ledger.readUploadLedgerPage({executionId:target,filter:"unfulfilled"});
    check(unfulfilledNow.rows.length===0,"The unfulfilled filter excludes fulfilled rows");
    for(const bad of [{limit:101},{limit:0},{after:-1},{filter:"x"},{executionId:"nope"}])
      await assert.rejects(()=>ledger.readUploadLedgerPage({executionId:target,...bad}),/INVALID_/);
    check(true,"The ledger rejects unbounded or malformed requests");
    check(getBlockedCertificationNetworkAttemptCount()===0,"Recovery performs no provider I/O");

    // Replay: no duplicate logical effects; fresh claim/fulfillment audit rows are intentional.
    const beforeReplay=await baseline();
    const receiptsBefore=(await probe.query(`SELECT count(*)::int n FROM audit_logs WHERE action='canonical_import_row_fulfilled'
      AND entity_key=ANY($1::text[])`,[after.map(row=>row.id)])).rows[0].n;
    const replayed=await processCanonicalImportRecoveryTick({maxItems:4,replay:{executionId:target,sourceRowNumbers:[1,2,3,4]}});
    check(replayed.fulfilled===4 && replayed.replay?.scopeAttempted===true,
      "Explicit replay reaches completed created originals through ordinary claims");
    assert.deepEqual(await baseline(),beforeReplay);
    assert.deepEqual(await accountingOf(target),accountingBefore);
    check((await probe.query(`SELECT count(*)::int n FROM audit_logs WHERE action='canonical_import_row_fulfilled'
      AND entity_key=ANY($1::text[])`,[after.map(row=>row.id)])).rows[0].n===receiptsBefore+4,
      "Replay creates no duplicate contacts, businesses or provenance and records only fresh claim/fulfillment audit rows");
    check((await processCanonicalImportRecoveryTick()).attempted===0,"Ordinary scheduling does not reselect qualified originals");
    // Rejected originals are never admitted, so these fixtures stay inert for later ticks.
    const inertRows=syntheticRows(2);
    inertRows.forEach(row=>{row.disposition="rejected";row.reasonCode="FIXTURE_INERT_REJECTED";});
    const stale=await seedExecution(inertRows,"ledger_stale_receipts");
    const staleItems=await items(stale);
    const staleAccounting=await accountingOf(stale);
    const receipt=(item:any,version:string,fingerprint:string)=>probe.query(`INSERT INTO audit_logs(action,entity_type,entity_key,details,actor_type,actor_id)
      VALUES('canonical_import_row_fulfilled','cro03_enrichment_item',$1,$2::jsonb,'system','system:canonical-import-recovery')`,
      [item.id,JSON.stringify({executionId:stale,sourceRowNumber:Number(item.row_number),qualificationVersion:version,rowFingerprint:fingerprint})]);
    const staleRows=staleAccounting.map(row=>({number:Number(row.source_row_number),fingerprint:row.row_fingerprint}));
    const byNumber=new Map(staleItems.map((item:any)=>[Number(item.row_number),item]));
    await receipt(byNumber.get(1),"mailbox_business_identity_v1",staleRows[0].fingerprint);
    await receipt(byNumber.get(2),"mailbox_business_identity_v2","f".repeat(64));
    const staleLedger=await ledger.readUploadLedgerPage({executionId:stale,limit:10});
    check(staleLedger.rows[0].receipt.status==="stale" && staleLedger.rows[1].receipt.status==="inconsistent",
      "Stale and inconsistent receipts are shown separately and never counted as current");
    const staleSummary=await ledger.readUploadLedgerSummary(stale);
    check(staleSummary.receiptsCurrent===0 && staleSummary.receiptsStale===1 && staleSummary.receiptsInconsistent===1,
      "The upload summary separates stale from inconsistent receipts");

    // Protected conflicting assignment: genuine foreign affiliation stays held.
    const firstMailbox=(await contactsByRow(target,1))[0];
    const protectedRow=syntheticRows(1)[0];
    protectedRow.rawRow.email_1=fixtures[0].rawRow.email_1;
    protectedRow.disposition="created";protectedRow.reasonCode="CANONICAL_PROVIDER_CONTACT_CREATED";
    rehash(protectedRow);
    const protectedExecution=await seedExecution([protectedRow],"staging_disabled_protected");
    await probe.query(`INSERT INTO contact_source_events(contact_id,event_key,source_category,source_type,
      import_execution_id,source_row_number,row_fingerprint,actor_type,metadata)
      VALUES($1,$2,'csv_import','outscraper',$3,1,$4,'import','{}'::jsonb)`,
      [firstMailbox.id,`canonical-provider:${protectedExecution}:1:${createHash("sha256").update(protectedRow.rawRow.email_1).digest("hex")}`,
        protectedExecution,protectedRow.rowFingerprint]);
    const protectedAccounting=await accountingOf(protectedExecution);
    const held=await processCanonicalImportRecoveryTick({maxItems:1});
    check(held.held===1 && held.fulfilled===0 && held.failed===0,
      "A created original with a genuinely conflicting assignment is held, not fulfilled");
    check((await probe.query("SELECT business_id FROM contacts WHERE id=$1",[firstMailbox.id])).rows[0].business_id===firstMailbox.business_id,
      "The protected assignment is never transferred");
    const heldItem=(await items(protectedExecution))[0];
    check(heldItem.terminal_code==="CANONICAL_IMPORT_CONTACT_AFFILIATION_HELD" && !heldItem.qualified &&
      await holdEvidence(protectedExecution)===1,"The hold appends new hold evidence and gets no fulfillment receipt");
    assert.deepEqual(await accountingOf(protectedExecution),protectedAccounting);

    // Retryable failure followed by ordinary-worker recovery.
    const retryRows=syntheticRows(1);retryRows[0].disposition="created";
    retryRows[0].reasonCode="CANONICAL_PROVIDER_CONTACT_CREATED";
    const retryExecution=await seedExecution(retryRows,"staging_disabled_retry");
    await probe.query(`CREATE FUNCTION fixture_retry_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.import_execution_id='${retryExecution}'::uuid THEN
        RAISE EXCEPTION 'fixture retryable fault' USING ERRCODE='23505'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fixture_retry_fault BEFORE INSERT ON contact_source_events
      FOR EACH ROW EXECUTE FUNCTION fixture_retry_fault()`);
    const failedTick=await processCanonicalImportRecoveryTick({maxItems:1});
    const failedItem=(await items(retryExecution))[0];
    check(failedTick.failed===1 && failedItem.state==="blocked" &&
      failedItem.terminal_code==="CANONICAL_IMPORT_RECOVERY_RETRY_REQUIRED" && !failedItem.qualified,
      "A retryable failure releases only its own claim as RETRY_REQUIRED");
    await probe.query("DROP TRIGGER fixture_retry_fault ON contact_source_events; DROP FUNCTION fixture_retry_fault()");
    await probe.query("UPDATE cro03_enrichment_items SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1",[failedItem.id]);
    const retrySelectable=(await db.execute(canonicalImportRecoveryClaimSql()) as any).rows;
    check(retrySelectable.length===1 && retrySelectable[0].execution_id===retryExecution,
      "RETRY_REQUIRED stays selectable because its eligibility is proven from the original claim receipt, not the mutable code");
    const retried=await processCanonicalImportRecoveryTick({maxItems:1});
    check(retried.fulfilled===1 && (await items(retryExecution))[0].qualified &&
      (await contactsByRow(retryExecution,1)).length===3,"The ordinary worker recovers the retried original with every mailbox");

    // The capability hold code is also retry-stable, but only with this worker's own receipt.
    const capabilityRows=syntheticRows(2);
    capabilityRows.forEach(row=>{row.disposition="created";row.reasonCode="CANONICAL_PROVIDER_CONTACT_CREATED";});
    const capabilityExecution=await seedExecution(capabilityRows,"staging_disabled_capability");
    const capabilityItems=await items(capabilityExecution);
    for(const [index,item] of capabilityItems.entries()) {
      await probe.query(`UPDATE cro03_enrichment_items SET state='blocked',
        terminal_code='CANONICAL_IMPORT_IDENTITY_BRIDGE_NATIVE_GUARD_MISSING',
        next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1`,[item.id]);
      if(index===0)await probe.query(`INSERT INTO audit_logs(action,entity_type,entity_key,details,actor_type,actor_id)
        VALUES('canonical_import_capability_opportunity','cro03_enrichment_item',$1,$2::jsonb,'system','system:canonical-import-recovery')`,
        [item.id,JSON.stringify({executionId:capabilityExecution,sourceRowNumber:1,
          rowFingerprint:capabilityRows[0].rowFingerprint,outcome:"blocked_source_capability"})]);
    }
    const capabilitySelectable=(await db.execute(canonicalImportRecoveryClaimSql()) as any).rows;
    check(capabilitySelectable.length===1 && Number(capabilitySelectable[0].source_row_number)===1,
      "Only the row with the worker's own capability receipt is admitted after a capability hold");
    const capabilityTick=await processCanonicalImportRecoveryTick({maxItems:2});
    check(capabilityTick.fulfilled===1 && (await items(capabilityExecution))[1].state==="blocked",
      "Capability restoration recovers the receipted row and never claims an unreceipted code");

    // Lease/owner loss: only the transaction without authority commits nothing.
    const lossRows=syntheticRows(1);lossRows[0].disposition="created";
    lossRows[0].reasonCode="CANONICAL_PROVIDER_CONTACT_CREATED";
    const lossExecution=await seedExecution(lossRows,"staging_disabled_owner_loss");
    let rotated=false;
    afterCommit=async()=>{
      if(rotated)return;
      const count=(await (originalQuery as any).call(probe,
        "SELECT count(*)::int n FROM contact_source_events WHERE import_execution_id=$1",[lossExecution])).rows[0].n;
      if(count<1)return;
      rotated=true;afterCommit=null;
      await (originalQuery as any).call(probe,`UPDATE sfp_runtime_owner_authority
        SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE authority_key='routine_sfp'`);
      await claimSfpRuntimeDeploymentOwner();
    };
    await assert.rejects(()=>processCanonicalImportRecoveryTick({maxItems:1}));
    afterCommit=null;
    const lossCount=async()=>(await probe.query(`SELECT count(DISTINCT contact_id)::int n FROM contact_source_events
      WHERE import_execution_id=$1`,[lossExecution])).rows[0].n;
    check(rotated && await lossCount()===1 && (await items(lossExecution))[0].state!=="completed",
      "Owner loss after one mailbox leaves that mailbox durable and the row unfulfilled");
    await probe.query(`UPDATE cro03_enrichment_items SET lease_expires_at=clock_timestamp()-interval '1 second',
      next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1`,[(await items(lossExecution))[0].id]);
    const resumed=await processCanonicalImportRecoveryTick({maxItems:1});
    check(resumed.fulfilled===1 && await lossCount()===3 && (await items(lossExecution))[0].qualified,
      "A fresh owner resumes the remaining mailboxes without duplicating the committed one");

    // The shared predicate literal CANONICAL_IMPORT_IDENTITY_BRIDGE_NATIVE_GUARD_MISSING appears in every
    // claim-check statement; a lock timeout echoing that SQL must remain a yieldable row failure.
    const {isRecoverableImportRowFailure}=await import("../../server/services/canonical-import-recovery-outcomes");
    const lockTimeout=Object.assign(new Error("canceling statement due to lock timeout"),{code:"55P03"});
    check(isRecoverableImportRowFailure(new Error("Failed query: ... NATIVE_GUARD_MISSING ...",{cause:lockTimeout})) &&
      !isRecoverableImportRowFailure(new Error("CANONICAL_IMPORT_IDENTITY_BRIDGE_NATIVE_GUARD_MISSING")),
      "A lock timeout echoing predicate SQL stays yieldable while a thrown guard-missing error stays fatal");
    // Changed payload: a different row presented for an already-retained original coordinate is rejected,
    // and a mutated execution payload never replaces the retained raw-v2/v3 evidence.
    const beforeChanged=await baseline();
    await assert.rejects(()=>materializeCanonicalProviderImportRow({executionId:target,sourceRowNumber:1,
      sourceFormat:"google_maps_outscraper",actorId:"fixture:changed-payload",
      rawRow:{...fixtures[0].rawRow,email_1:`changed.${randomUUID()}@example.test`}}),
      /PROVIDER_IMPORT_ORIGINAL_EVIDENCE_MISMATCH/);
    assert.deepEqual(await baseline(),beforeChanged);
    check(true,"A changed payload for a retained original coordinate is rejected without any graph or provenance write");
    const mutatedEmail=`mutated.${randomUUID()}@example.test`;
    const changedRows=syntheticRows(1);changedRows[0].disposition="created";
    changedRows[0].reasonCode="CANONICAL_PROVIDER_CONTACT_CREATED";
    const changedExecution=await seedExecution(changedRows,"staging_disabled_changed_payload");
    const changedItem=(await items(changedExecution))[0];
    // First fulfillment retains raw-v2/v3; afterwards the mutable execution payload is irrelevant.
    await processCanonicalImportRecoveryTick({maxItems:1});
    await probe.query(`UPDATE import_executions SET source_payload=jsonb_set(source_payload,'{0,email_1}',to_jsonb($2::text))
      WHERE id=$1`,[changedExecution,mutatedEmail]);
    await probe.query("UPDATE cro03_enrichment_items SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1",[changedItem.id]);
    const mutatedReplay=await processCanonicalImportRecoveryTick({maxItems:1,
      replay:{executionId:changedExecution,sourceRowNumbers:[1]}});
    check(mutatedReplay.fulfilled===1 &&
      (await probe.query("SELECT count(*)::int n FROM contacts WHERE email=$1",[mutatedEmail])).rows[0].n===0,
      "Retained raw evidence, not a mutated execution payload, governs replay");
  }else if(phase==="faults"){
    const rows=syntheticRows(),execution=await seedExecution(rows,"faults");
    const target=(await items(execution))[0];
    await probe.query(`CREATE FUNCTION fixture_recovery_claim_notification() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id='${target.id}'::uuid AND NEW.state='running' AND OLD.state<>'running'
        THEN PERFORM pg_notify('fixture_recovery_claim',NEW.id::text); END IF; RETURN NEW; END $$;
      CREATE TRIGGER fixture_recovery_claim_notification AFTER UPDATE ON cro03_enrichment_items
      FOR EACH ROW EXECUTE FUNCTION fixture_recovery_claim_notification()`);
    const locker=new pg.Client({connectionString:process.env.DATABASE_URL});await locker.connect();
    const listener=new pg.Client({connectionString:process.env.DATABASE_URL});await listener.connect();
    let heldResolve:()=>void;const held=new Promise<void>(resolve=>{heldResolve=resolve;});
    listener.on("notification",()=>{
      void (async()=>{await locker.query("BEGIN");await locker.query("SELECT id FROM cro03_enrichment_items WHERE id=$1 FOR UPDATE",[target.id]);heldResolve();})()
        .catch(error=>{status=1;console.error("FIXTURE_LOCKER_FAILED",error.code);});
    });
    await listener.query("LISTEN fixture_recovery_claim");
    const tick=processCanonicalImportRecoveryTick({maxItems:2});
    await Promise.race([held,delay(5000).then(()=>{throw new Error("FIXTURE_CLAIM_NOTIFICATION_TIMEOUT");})]);
    const result=await tick;
    check(result.fulfilled===1 && result.failed===1 && result.cleanupFailed===1 && result.abandoned===1,
      "Native row/cleanup lock timeouts yield to a different eligible row under healthy authority");
    const retained=(await items(execution))[0];
    check(retained.state==="running" && retained.claim_token && retained.current_provider==="canonical_local_import",
      "Failed cleanup leaves the original claim intact, not an unfenced release");
    const errors=diagnostics.flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
    const first=errors.find(e=>e.event==="canonical_import_recovery_original_error");
    const cleanup=errors.find(e=>e.event==="canonical_import_recovery_cleanup_error");
    check(first?.failureId===cleanup?.failureId && first?.sourceRowNumber===1,
      "Original and cleanup failures retain the same failure identity");
    await locker.query("ROLLBACK");await locker.end();await listener.end();
    await probe.query("DROP TRIGGER fixture_recovery_claim_notification ON cro03_enrichment_items; DROP FUNCTION fixture_recovery_claim_notification()");
    await probe.query("UPDATE cro03_enrichment_items SET lease_expires_at=clock_timestamp()-interval '1 second',next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1",[target.id]);
    const {hasCanonicalImportRecoveryClaim}=await import("../../server/services/canonical-import-recovery-contract");
    check(!await db.transaction(tx=>hasCanonicalImportRecoveryClaim(tx,{executionId:execution,sourceRowNumber:1,
      rowFingerprint:rows[0].rowFingerprint,recoveryClaim:{itemId:target.id,claimToken:retained.claim_token},renew:true})),
      "The native expiry predicate refuses to renew the expired original claim");
    await assert.rejects(()=>materializeCanonicalProviderImportRow({executionId:execution,sourceRowNumber:1,
      sourceFormat:rows[0].sourceFormat,rawRow:rows[0].rawRow,actorId:"fixture:stale",
      recoveryClaim:{itemId:target.id,claimToken:retained.claim_token}}),(error:any)=>{
        for(let current=error,depth=0;current && depth<6;current=current.cause,depth++)
          if(/LEASE_LOST|AUTHORITY_REJECTED|AUTHORITY_FENCE_LOST/.test(current.message ?? ""))return true;
        return false;
      });
    check(true,"An expired original token cannot materialize or revive the abandoned row");

    // Lose the reply AFTER a real native mailbox transaction commits.
    const partialRows=syntheticRows(1),partial=await seedExecution(partialRows,"commit_reply_loss");
    let loseReply=true;
    afterCommit=async()=>{
        if(!loseReply)return;
        const count=(await (originalQuery as any).call(probe,
          "SELECT count(*)::int n FROM contact_source_events WHERE import_execution_id=$1",[partial])).rows[0].n;
        if(count>0){loseReply=false;const error=new Error("FIXTURE_COMMIT_REPLY_LOST");Object.assign(error,{code:"ECONNRESET"});throw error;}
    };
    await assert.rejects(()=>processCanonicalImportRecoveryTick({maxItems:1}),
      (error:any)=>{
        if(!(error instanceof CanonicalImportRecoveryFailure))return false;
        for(let current:any=error,depth=0;current && depth<6;current=current.cause,depth++)
          if(current.code==="ECONNRESET")return true;
        return false;
      });
    afterCommit=null;
    check(!loseReply,"A genuinely committed mailbox with a lost reply is an explicit fatal outcome, never retried in-tick");
    const partialContacts=(await probe.query("SELECT count(DISTINCT contact_id)::int n FROM contact_source_events WHERE import_execution_id=$1",[partial])).rows[0].n;
    check(partialContacts===1 && (await items(partial))[0].state!=="completed",
      "One committed mailbox is not reported as a completed multi-mailbox row");
    await probe.query(`UPDATE cro03_enrichment_items item SET next_attempt_at=clock_timestamp()-interval '1 second'
      FROM cro03_enrichment_batches batch WHERE batch.id=item.batch_id AND batch.idempotency_key LIKE $1`,
    [`csv-source:${partial}:%`]);
  }else if(phase==="restart"){
    const result=await processCanonicalImportRecoveryTick({maxItems:4});
    check(result.fulfilled===2,"A fresh process reclaims abandoned work and resumes partial mailbox materialization");
    for(const kind of ["faults","commit_reply_loss"]){
      for(const execution of await executions(kind)){
        const count=(await probe.query("SELECT count(DISTINCT contact_id)::int n FROM contact_source_events WHERE import_execution_id=$1",[execution.id])).rows[0].n;
        const rowCount=(await items(execution.id)).length;
        check(count===rowCount*3 && (await items(execution.id)).every(item=>item.state==="completed"),
          `${kind}: every mailbox, not merely row accounting, survives restart`);
      }
    }
    const before=await baseline();await processCanonicalImportRecoveryTick();
    assert.deepEqual(await baseline(),before);check(true,"Restart replay creates no duplicate contacts, businesses or provenance");
  }else if(phase==="legacy"){
    const execution=await seedExecution(syntheticRows(1),"legacy_certificate");
    await processCanonicalImportRecoveryTick({maxItems:1});
    const before=await baseline(),item=(await items(execution))[0];
    await probe.query("UPDATE audit_logs SET details=details-'qualificationVersion' WHERE entity_key=$1 AND action='canonical_import_row_fulfilled'",[item.id]);
    await probe.query("UPDATE cro03_enrichment_items SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1",[item.id]);
    const verified=await processCanonicalImportRecoveryTick({maxItems:1});
    check(verified.fulfilled===1,"Previously completed rows lacking business-link qualification are reverified through the real source claim");
    assert.deepEqual(await baseline(),before);
    check(!(await processCanonicalImportRecoveryTick()).ran,"A qualified certificate stops repeated legacy reconciliation without duplicates");
    const conflictRows=syntheticRows(2);
    conflictRows[0].rawRow.name=`North Clinic ${randomUUID()}`;
    conflictRows[1].rawRow.name=`South Retail ${randomUUID()}`;
    for(const key of ["email_1","email_2","additional_emails"]){
      conflictRows[1].rawRow[key]=conflictRows[0].rawRow[key];
    }
    for(const row of conflictRows)row.rowFingerprint=createHash("sha256").update(JSON.stringify(row.rawRow)).digest("hex");
    const conflicting=await seedExecution(conflictRows,"shared_mailbox_conflict");
    await processCanonicalImportRecoveryTick({maxItems:2});
    const conflictingItems=await items(conflicting);
    assert(conflictingItems.every(item=>item.state==="completed"&&item.qualified));
    const shared=(await probe.query(`SELECT event.source_row_number,event.row_fingerprint,
      contact.id,contact.email,contact.business_id,business.canonical_name
      FROM contact_source_events event JOIN contacts contact ON contact.id=event.contact_id
      JOIN businesses business ON business.id=contact.business_id
      WHERE event.import_execution_id=$1`,[conflicting])).rows;
    assert.equal(shared.length,6);assert.equal(new Set(shared.map(contact=>contact.id)).size,6);
    assert.equal(new Set(shared.map(contact=>contact.business_id)).size,2);
    for(const row of conflictRows){
      const recipients=shared.filter(contact=>contact.source_row_number===row.sourceRowNumber);
      assert.deepEqual(recipients.map(contact=>contact.email).sort(),providerImportEmails(row.rawRow));
      assert(recipients.every(contact=>contact.row_fingerprint===row.rowFingerprint
        &&contact.canonical_name===row.rawRow.name));
    }
    check(true,"Distinct supported business identities sharing addresses keep separate people and exact provenance without transferring the first relationship");
  }else if(phase==="budget"){
    const rows=syntheticRows(1),execution=await seedExecution(rows,"held_budget");
    const owner=await claimSfpRuntimeDeploymentOwner();
    await probe.query("SELECT pg_advisory_lock(hashtextextended($1,0))",[LADDER_BUDGET_LOCK_KEY]);
    const dispatch=dispatchStoppedAfterBudget()({operationId:randomUUID(),claimToken:randomUUID(),
      provider:"openai_classification",runtimeOwnerEpoch:owner.ownerEpoch,runtimeOwnerToken:owner.ownerToken})
      .then(()=>null,(error:any)=>error);
    let blocked=false;
    for(let n=0;n<100 && !blocked;n++){
      blocked=(await probe.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))) blocked",[(probe as any).processID])).rows[0].blocked;
      if(!blocked)await delay(10);
    }
    check(blocked,"Actual dispatch transaction is held behind the real shared paid-budget lock");
    const leaseBefore=(await probe.query("SELECT lease_expires_at::text lease FROM sfp_runtime_owner_authority WHERE authority_key='routine_sfp'")).rows[0].lease;
    const claim=await claimSfpRuntimeDeploymentOwner();
    check(claim.ownerEpoch===owner.ownerEpoch && claim.ownerToken===owner.ownerToken,
      "Actual routine recovery claim verifies the live owner without exclusive handoff or token change");
    assert.equal((await probe.query("SELECT lease_expires_at::text lease FROM sfp_runtime_owner_authority WHERE authority_key='routine_sfp'")).rows[0].lease,leaseBefore);
    check(true,"Routine verification neither renews the lease nor mutates authority");
    const result=await processCanonicalImportRecoveryTick({maxItems:1});
    check(result.fulfilled===1 && result.failed===0 && (await items(execution))[0].state==="completed",
      "Actual recovery tick and real mailbox/business materialization commit while dispatch remains budget-blocked");
    check(result.authorityAcquisitionMs>=0 && result.rowProcessingMs>0,
      "Authority acquisition and row processing have separate truthful timings");
    await probe.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[LADDER_BUDGET_LOCK_KEY]);
    check((await dispatch)?.message==="FIXTURE_STOP_BEFORE_PROVIDER","Budget fixture ends before any provider dispatch");
    await probe.query("BEGIN");
    await probe.query("SELECT authority_key FROM sfp_runtime_owner_authority WHERE authority_key='routine_sfp' FOR UPDATE");
    await assert.rejects(()=>processCanonicalImportRecoveryTick({maxDurationMs:1}));
    const acquisition=diagnostics.flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}})
      .filter(event=>event.event==="canonical_import_recovery_tick").at(-1);
    check(acquisition?.outcome==="authority_acquisition_failed" && acquisition.attempted===0 &&
      acquisition.fulfilled===0 && acquisition.rowProcessingMs===0 && acquisition.authorityAcquisitionMs>=900,
      "Bounded initial acquisition failure reports zero row work and its own wait duration");
    await probe.query("ROLLBACK");
    const excluded=syntheticRows(1);excluded[0].disposition="failed";excluded[0].reasonCode="IMPORT_ROW_FAILED";
    const excludedExecution=await seedExecution(excluded,"excluded_original_failure");
    const noWork=await processCanonicalImportRecoveryTick();
    check(!noWork.ran && (await items(excludedExecution))[0].state==="blocked",
      "Unrelated originally failed rows do not acquire the narrow staging-infrastructure retry authority");
    await assert.rejects(()=>renewSfpRuntimeDeploymentOwner({expectedOwner:{ownerEpoch:owner.ownerEpoch+1,ownerToken:owner.ownerToken}}),/FENCE_LOST/);
    await assert.rejects(()=>renewSfpRuntimeDeploymentOwner({expectedOwner:{ownerEpoch:owner.ownerEpoch,ownerToken:randomUUID()}}),/FENCE_LOST/);
    check(true,"The separate renewal path rejects stale epochs and tokens");
    await probe.query("UPDATE sfp_runtime_owner_authority SET lease_expires_at=clock_timestamp()+interval '20 seconds' WHERE authority_key='routine_sfp'");
    await processCanonicalImportRecoveryTick();
    const renewed=(await probe.query("SELECT owner_epoch,owner_token,lease_expires_at>clock_timestamp()+interval '90 seconds' live FROM sfp_runtime_owner_authority WHERE authority_key='routine_sfp'")).rows[0];
    check(Number(renewed.owner_epoch)===owner.ownerEpoch && renewed.owner_token===owner.ownerToken && renewed.live,
      "A near-expiry lease is legitimately renewed in a separate short fenced transition");
    await probe.query("UPDATE sfp_runtime_owner_authority SET revoked_at=clock_timestamp() WHERE authority_key='routine_sfp'");
    await assert.rejects(()=>processCanonicalImportRecoveryTick(),/OWNER_REVOKED/);
    check(true,"Actual initial recovery acquisition rejects a revoked owner");
    await probe.query("UPDATE sfp_runtime_owner_authority SET revoked_at=NULL,lease_expires_at=clock_timestamp()-interval '1 second' WHERE authority_key='routine_sfp'");
    await assert.rejects(()=>renewSfpRuntimeDeploymentOwner({expectedOwner:owner}),/FENCE_LOST/);
    const reclaimed=await claimSfpRuntimeDeploymentOwner();
    check(reclaimed.ownerEpoch>owner.ownerEpoch && reclaimed.ownerToken!==owner.ownerToken,
      "Expired authority cannot renew; legitimate reclamation rotates epoch and token");
  }else if(phase==="upload_interrupt"){
    // The actual September corpus has at most one mailbox per row. Exercise
    // future multi-mailbox upload with an explicitly controlled NEW input in
    // the exact restored native graph; never rewrite a historical source row.
    const native=syntheticRows(1)[0];
    const before=await baseline(),sourcePayload=[native.rawRow];
    const claim=await claimCsvExecution({fileHash:createHash("sha256").update(JSON.stringify(sourcePayload)).digest("hex"),
      totalRows:1,actorType:"import",actorId:"system:native-ordinary-upload",
      sourcePayload,metadata:{certificationKind:"native_ordinary_upload",sourceFormat:native.sourceFormat,
        controlledNewUpload:true,nativeOrdinaryBaseline:before}});
    assert(claim.claimed&&claim.claimToken);
    let loseReply=true;
    afterCommit=async()=>{
      if(!loseReply)return;
      const count=(await (originalQuery as any).call(probe,
        "SELECT count(*)::int n FROM contact_source_events WHERE import_execution_id=$1",[claim.execution.id])).rows[0].n;
      if(count===1){loseReply=false;throw Object.assign(new Error("FIXTURE_NATIVE_UPLOAD_COMMIT_REPLY_LOST"),{code:"ECONNRESET"});}
    };
    await assert.rejects(()=>materializeCanonicalProviderImportRow({executionId:claim.execution.id,
      claimToken:claim.claimToken!,sourceRowNumber:1,sourceFormat:native.sourceFormat,
      rawRow:native.rawRow,actorId:"system:native-ordinary-upload"}));
    afterCommit=null;
    check(!loseReply,"Ordinary native upload loses confirmation after exactly one real mailbox commit");
    const incomplete=await completeImportExecution({executionId:claim.execution.id,
      claimToken:claim.claimToken!,expectedRows:1});
    check(!incomplete.completed,"Original row accounting cannot complete an ordinary upload with an unfinished mailbox");
    assert((await baseline()).contacts<=before.contacts+1);
    assert.equal((await baseline()).businesses,before.businesses+1);
    await probe.query(`UPDATE import_executions SET lease_expires_at=clock_timestamp()-interval '1 second'
      WHERE id=$1`,[claim.execution.id]);
  }else if(phase==="upload_restart"){
    const execution=(await probe.query(`SELECT * FROM import_executions
      WHERE metadata->>'certificationKind'='native_ordinary_upload'`)).rows[0];
    assert(execution);
    const raw=execution.source_payload[0],expected=providerImportEmails(raw),before=await baseline();
    const claim=await claimCsvExecution({fileHash:execution.file_hash,totalRows:1,
      actorType:"import",actorId:"system:native-ordinary-upload",sourcePayload:execution.source_payload,
      metadata:execution.metadata});
    assert.equal(claim.execution.id,execution.id);assert(claim.claimed&&claim.claimToken);
    const result=await materializeCanonicalProviderImportRow({executionId:execution.id,
      claimToken:claim.claimToken!,sourceRowNumber:1,sourceFormat:execution.metadata.sourceFormat,
      rawRow:raw,actorId:"system:native-ordinary-upload"});
    assert.equal(result.fulfillmentState,"completed");
    await completeImportExecution({executionId:execution.id,claimToken:claim.claimToken!,expectedRows:1});
    const proven=(await probe.query(`SELECT DISTINCT contact.id,contact.email,contact.business_id FROM contact_source_events event
      JOIN contacts contact ON contact.id=event.contact_id WHERE event.import_execution_id=$1`,[execution.id])).rows;
    assert.deepEqual(proven.map(contact=>contact.email.toLowerCase()).sort(),expected);
    assert(proven.every(contact=>contact.business_id===result.businessId));
    const created=(await probe.query("SELECT count(*)::int rows FROM contacts WHERE import_batch_id=$1",
      [execution.id])).rows[0].rows;
    assert(created<=expected.length);
    assert.equal((await baseline()).contacts,execution.metadata.nativeOrdinaryBaseline.contacts+created);
    assert.equal((await probe.query("SELECT count(*)::int rows FROM contact_source_events WHERE import_execution_id=$1",
      [execution.id])).rows[0].rows,expected.length);
    assert.equal((await baseline()).businesses,before.businesses);
    assert((await claimCsvExecution({fileHash:execution.file_hash,totalRows:1,
      actorType:"import",actorId:"system:native-ordinary-upload"})).replay);
    check(true,"A fresh ordinary process resumes every actual native mailbox and business link without duplicate people or businesses");
    const protectedRelationships=await verifyRetainedBusinessRelationships(probe);
    writeFileSync("/tmp/retained-native-upload-restart-report.json",JSON.stringify({
      phase:"ordinary_native_fresh_process_restart",expectedMailboxes:expected.length,
      provenMailboxes:proven.length,controlledNewUpload:true,
      ...protectedRelationships,providerCalls:0,outboundEffects:0},null,2));
  }else if(phase==="seed"){
    const rows=inputRows();
    const execution=await seedNativeRetainedTopology(rows,certificationEnvironment);
    check((await items(execution)).length===1472,"All original retained raw rows have one indexed source work item");
    check(rows.filter(row=>row.disposition==="failed" && row.reasonCode==="RECOVERY_PROVIDER_STAGING_FAILED").length===1,
      "The original infrastructure-failed row is preserved rather than rewritten as deferred");
  }else if(phase==="recover" || phase==="replay"){
    const original=(await executions("retained_original"))[0];assert(original);
    const rows=inputRows(),before=await baseline();
    const accountingBefore=(await probe.query("SELECT source_row_number,disposition,reason_code,row_fingerprint FROM import_row_dispositions WHERE execution_id=$1 ORDER BY source_row_number",[original.id])).rows;
    const remainingReplayRows=new Set(rows.map(row=>row.sourceRowNumber));
    let transientFailures=0,cycles=0;
    for(;cycles<100;cycles++){
      const replayScope=phase==="replay"
        ? {executionId:original.id,sourceRowNumbers:[...remainingReplayRows].slice(0,250)} : undefined;
      const results=await Promise.allSettled(replayScope
        ? [processCanonicalImportRecoveryTick({replay:replayScope})]
        : [processCanonicalImportRecoveryTick(),processCanonicalImportRecoveryTick()]);
      if(replayScope)for(const result of results)if(result.status==="fulfilled")
        for(const row of result.value.replay?.rowOutcomes ?? [])
          if(row.outcome!=="failed")remainingReplayRows.delete(row.sourceRowNumber);
      for(const result of results)if(result.status==="rejected"){
        // No arbitrary error becomes acceptable just because another worker
        // happened to reclaim the owner before this result was observed.
        let authorityLoss=false;
        for(let error:any=result.reason,depth=0;error && depth<6;error=error.cause,depth++){
          if(/SFP_RUNTIME_OWNER_FENCE_LOST|CANONICAL_IMPORT_RECOVERY_RUNTIME_OWNER_CHANGED/.test(error.message ?? "")){
            authorityLoss=true;break;
          }
        }
        if(!authorityLoss)throw result.reason;
        transientFailures++;
      }
      const state=await items(original.id);
      console.log(JSON.stringify({event:"retained_fixture_cycle",phase,cycle:cycles+1,
         completed:state.filter(item=>item.state==="completed"&&item.qualified).length,
        running:state.filter(item=>item.state==="running").length}));
      const retry=state.filter(item=>item.state==="running" || item.terminal_code==="CANONICAL_IMPORT_RECOVERY_RETRY_REQUIRED");
      if(phase!=="replay" && retry.length)await probe.query(`UPDATE cro03_enrichment_items SET
        lease_expires_at=CASE WHEN state='running' THEN clock_timestamp()-interval '1 second' ELSE lease_expires_at END,
        next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=ANY($1::uuid[])`,[retry.map(item=>item.id)]);
       const eligible=state.filter(item=>(item.state==="completed"&&!item.qualified) ||
         item.terminal_code==="STAGING_RECIPE_DISABLED" || item.state==="running" ||
        item.terminal_code==="CANONICAL_IMPORT_RECOVERY_RETRY_REQUIRED");
      if(phase==="replay" ? remainingReplayRows.size===0 : !eligible.length)break;
    }
    check(cycles<100,"Concurrent real recovery workers converge without unresolved retry/running work");
    const final=await items(original.id);
    const contacts=(await probe.query("SELECT id,email,business_id FROM contacts")).rows;
    const byId=new Map(contacts.map(contact=>[contact.id,contact]));
    const provenance=(await probe.query("SELECT contact_id,source_row_number,row_fingerprint FROM contact_source_events WHERE import_execution_id=$1",[original.id])).rows;
    const evidence=new Set(provenance.map(event=>`${event.source_row_number}:${event.row_fingerprint}:${event.contact_id}`));
    const audits=(await probe.query(`SELECT DISTINCT ON(entity_key) entity_key,details FROM audit_logs
      WHERE action='canonical_import_row_fulfilled' AND details->>'executionId'=$1 ORDER BY entity_key,created_at DESC`,[original.id])).rows;
    const receipts=new Map(audits.map(audit=>[audit.entity_key,audit.details]));
    const heldAudits=(await probe.query(`SELECT DISTINCT ON(entity_key) entity_key,details FROM audit_logs
      WHERE action='canonical_import_row_held' AND details->>'executionId'=$1 ORDER BY entity_key,created_at DESC`,[original.id])).rows;
    const holdEvidence=new Map(heldAudits.map(audit=>[audit.entity_key,audit.details]));
    const businessIds=new Set((await probe.query("SELECT id FROM businesses")).rows.map(row=>row.id));
    let mailboxes=0;const held:Record<string,number>={};
    const rowOutcomes=final.map(item=>{
      const raw=rows[item.row_number-1],expected=providerImportEmails(raw.rawRow);
      if(item.state==="completed"){
        assert.equal(item.terminal_code,"CANONICAL_LOCAL_IMPORT_FULFILLED");
        const receipt=receipts.get(item.id);assert(receipt && businessIds.has(receipt.businessId));
        const found=(receipt.contactIds as number[]).map(id=>byId.get(id)!);
        assert.deepEqual(found.map(contact=>contact.email.toLowerCase()).sort(),expected);
        for(const contact of found){assert.equal(contact.business_id,receipt.businessId,`LINKAGE_GAP_ROW_${item.row_number}`);
          assert(evidence.has(`${item.row_number}:${raw.rowFingerprint}:${contact.id}`));}
        mailboxes+=expected.length;
        return {row:item.row_number,outcome:"fulfilled",expectedMailboxes:expected.length,provenMailboxes:found.length};
      }
      assert.equal(item.state,"blocked");
      assert(/^CANONICAL_IMPORT_(AMBIGUOUS_ORGANIZATION_MATCH|BUSINESS_IDENTITY_MISSING|STABLE_SOURCE_CONFLICT|INSUFFICIENT|CONTACT_AFFILIATION_HELD|CONTACT_IDENTITY_AMBIGUOUS)/.test(item.terminal_code),
        `Unexplained retained-row hold ${item.row_number}: ${item.terminal_code}`);
      const heldReceipt=holdEvidence.get(item.id);
      assert(heldReceipt?.reasonCode===item.terminal_code && heldReceipt.rowFingerprint===raw.rowFingerprint);
      if(item.terminal_code==="CANONICAL_IMPORT_CONTACT_IDENTITY_AMBIGUOUS"){
        const candidates=heldReceipt.diagnostic.candidateContactIds;
        assert(Array.isArray(candidates)&&new Set(candidates).size>=2&&candidates.every((id:number)=>byId.has(id)),
          "Ambiguous-contact hold must retain the actual competing contact identities");
      }
      if(item.terminal_code==="CANONICAL_IMPORT_CONTACT_AFFILIATION_HELD"){
        const diagnostic=heldReceipt.diagnostic;
        assert(businessIds.has(diagnostic.businessId) && diagnostic.incomplete.length>0);
        assert(diagnostic.incomplete.every((contact:any)=>contact.business_id!==diagnostic.businessId));
      }
      held[item.terminal_code]=(held[item.terminal_code] ?? 0)+1;
      return {row:item.row_number,outcome:"held",reason:item.terminal_code,expectedMailboxes:expected.length,provenMailboxes:0};
    });
    assert.deepEqual((await probe.query("SELECT source_row_number,disposition,reason_code,row_fingerprint FROM import_row_dispositions WHERE execution_id=$1 ORDER BY source_row_number",[original.id])).rows,accountingBefore);
    const protectedRelationships=await verifyRetainedBusinessRelationships(probe);
    check(true,"Every original projected relationship, decision and evidence row is preserved");
    check(true,"Every original row, expected mailbox, business link and fingerprint-bound provenance is reconciled; immutable dispositions unchanged");
    if(phase==="replay"){
      assert.equal(remainingReplayRows.size,0,"Every original must traverse the actual native replay selector");
      assert.deepEqual(await baseline(),before);
      check(true,"Full retained-workload materialization replay creates no contact, business or provenance duplicates without item rearming or lease expiry");
    }
    const report={phase,rows:1472,fulfilled:final.filter(item=>item.state==="completed").length,
      held,provenMailboxes:mailboxes,cycles:cycles+1,explicitLeaseExpiryFailures:transientFailures,
      ...protectedRelationships,
      inputDigest:original.metadata.inputDigest,providerCalls:0,outboundEffects:0,rowOutcomes};
    writeFileSync(`/tmp/retained-recovery-${phase}-report.json`,JSON.stringify(report,null,2));
    console.log(JSON.stringify({...report,rowOutcomes:undefined}));
  }else throw new Error("RETAINED_CERTIFICATION_UNKNOWN_PHASE");
  const safetyAfter=await baseline();
  for(const key of ["provider_operations","communications","validation_intents"] as const)assert.equal(safetyAfter[key],safetyBefore[key]);
  check(getBlockedCertificationNetworkAttemptCount()===0,"Zero provider, outbound or nonselective validation admission attempts");
  console.log(`RETAINED_RECOVERY_PHASE_PASS ${phase} checks=${checks}`);
}catch(error:any){
  status=1;
  const {safeDatabaseFailure}=await import("../../server/lib/lock-trace");
  console.error("RETAINED_RECOVERY_PHASE_FAILED",phase,error?.message?.startsWith("Unexplained") ? error.message : error?.name,
    JSON.stringify(safeDatabaseFailure(error)),
    /^[A-Z0-9_:]+$/.test(error?.message ?? "") ? error.message : null,
    String(error?.stack).split("\n").find(line=>line.includes("retained-native-topology.ts")) ?? "",
    String(error?.stack).split("\n")
      .find(line=>line.includes("test-retained-canonical-import-recovery.ts")) ?? "");
}finally{
  afterCommit=null;
  pg.Client.prototype.query=originalQuery;console.warn=originalWarn;
  await probe.query("SELECT pg_advisory_unlock_all()");await probe.end();await pool.end();
}
// This is also the deliberate process boundary used to test restart. An
// optional read-only observer must not keep a finished disposable child alive.
process.exit(status);
