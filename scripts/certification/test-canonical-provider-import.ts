import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import {sql} from "drizzle-orm";
import {assertDisposableTestInfrastructure} from "../test-infrastructure-guard";
import {applyCertificationProviderDenyBoundary,getBlockedCertificationNetworkAttemptCount} from "../certification-provider-deny";
await assertDisposableTestInfrastructure({operation:"canonical provider import certification"});
process.env.VG_PROVIDER_DENY_MODE="1";
applyCertificationProviderDenyBoundary({fatal:true});
const {db,pool}=await import("../../server/db");
const {claimCsvExecution,recordImportRowDisposition,completeImportExecution}=await import("../../server/services/import-execution");
const {materializeCanonicalProviderImportRow,providerImportEmails,providerImportRecipient}=await import("../../server/services/canonical-provider-import");
const {initializeImportedLinkedContactClass}=await import("../../server/services/commercial-classification-authority");
const {canonicalImportRecoveryClaimSql}=await import("../../server/services/canonical-import-recovery-worker");
const {PgDialect}=await import("drizzle-orm/pg-core");
let checks=0;
const check=(value:unknown,message:string)=>{assert(value,message);checks++;};
const actorId=`cert_import_${randomUUID()}`;
const label=randomUUID().replaceAll("-","");
const raw={name:`Canonical Import ${label}`,place_id:`cert_place_${label}`,category:"Automotive",
  city:"Miami",state:"FL",email_1:`owner.${label}@gmail.com`,email_2:`office.${label}@gmail.com`,
  additional_emails:`owner.${label}@GMAIL.com; second.${label}@example.com`,
  unrecognized_provider_column:"preserve unchanged"};
const newClaim=()=>claimCsvExecution({fileHash:createHash("sha256").update(randomUUID()).digest("hex"),
  totalRows:1,actorType:"import",actorId,sourcePayload:[raw]});
try {
  const nativeClaim=new PgDialect().sqlToQuery(canonicalImportRecoveryClaimSql());
  const claimPlan=(await pool.query(`EXPLAIN (VERBOSE, FORMAT JSON) ${nativeClaim.sql}`,nativeClaim.params))
    .rows[0]["QUERY PLAN"][0].Plan;
  const planNodes=(node:any):any[]=>[node,...(node.Plans ?? []).flatMap(planNodes)];
  const nodes=planNodes(claimPlan);
  const selectedScope=nodes.find(node=>node["Subplan Name"]==="CTE selected_import");
  check(selectedScope?.["Node Type"]==="Limit" && nodes.some(node=>node["Node Type"]==="LockRows"),
    "Native recovery limits and locks one eligible original source item inside a materialized scope");
  check(selectedScope.Output.every((field:string)=>!field.includes("source_payload")&&!field.includes("COALESCE")),
    "Workbook original raw JSON is not projected for every sortable backlog row");
  check(nodes.some(node=>node["Node Type"]==="Subquery Scan" && node.Alias==="observation"),
    "Native observation lookup remains membership-ID-correlated instead of a global fingerprint payload scan");
  check(claimPlan.Output.some((field:string)=>field.includes("COALESCE")&&field.includes("source_payload")),
    "The actual chosen original raw payload still opens after selection; original availability is not bypassed");
  const before=(await pool.query(`SELECT
    (SELECT count(*) FROM provider_operations)::int operations,
    (SELECT count(*) FROM communication_events)::int communications,
    (SELECT count(*) FROM sfp_cohort_runs)::int cohorts`)).rows[0];
  const claim=await newClaim();
  const args={executionId:claim.execution.id,claimToken:claim.claimToken!,sourceRowNumber:1,
    sourceFormat:"google_maps_outscraper",actorId,rawRow:raw};
  const result=await materializeCanonicalProviderImportRow(args);
  check(result.contactIds.length===3,"Every distinct retained address becomes a contact, not only the first email");
  const contacts=(await pool.query("SELECT id,business_id,record_class,email_status FROM contacts WHERE id=ANY($1::integer[])",
    [result.contactIds])).rows;
  check(contacts.every(c=>c.business_id===result.businessId),"Real native independent Maps affiliation is applied");
  check(contacts.every(c=>c.record_class==="production"),"Original source plus verified canonical root establishes initial class");
  check(contacts.every(c=>c.email_status==="unvalidated"),"A CSV does not manufacture hygiene receipts");
  check((await pool.query("SELECT count(*)::int n FROM business_locations WHERE business_id=$1 AND google_place_id=$2",
    [result.businessId,raw.place_id])).rows[0].n===1,"Retained structured location/place evidence projects to the canonical location");
  check((await pool.query("SELECT count(*)::int n FROM validation_intents")).rows[0].n===0,
    "Importing addresses alone does not populate a paid-validation queue");
  const programId=randomUUID();
  await pool.query(`INSERT INTO sfp_programs
    (id,name,county_fips,vertical_ids,taxonomy_version,is_active,created_by)
    VALUES($1,$2,ARRAY['12086'],ARRAY['Automotive'],2,TRUE,$3)`,[programId,label,actorId]);
  const sequenceId=(await pool.query(`INSERT INTO follow_up_sequences(name,status,trigger_config)
    VALUES($1,'paused',$2::jsonb) RETURNING id`,[label,
      JSON.stringify({canonicalProgramId:programId,canonicalVerticals:["Automotive"]})])).rows[0].id;
  const {prepareCanonicalRecipient}=await import("../../server/services/canonical-recipient-preparation");
  const prepared=await prepareCanonicalRecipient({contactId:result.contactIds[0],programId,sequenceId,
    actor:{role:"admin",actorId,email:null},source:"canonical_import_certification"});
  check(prepared.preparationState==="pending_validation" && prepared.enrollmentId!=null,
    "Original import flows through real canonical classification, affiliation and paused preparation with no cohort");
  check((await pool.query("SELECT count(*)::int n FROM validation_intents")).rows[0].n===1,
    "Only the actual selected prepared recipient admits a validation intent");
  check((await pool.query("SELECT count(*)::int n FROM import_row_dispositions WHERE execution_id=$1",
    [claim.execution.id])).rows[0].n===1,"Multi-person/multi-address rows count exactly once");
  const retained=(await pool.query(`SELECT o.payload FROM cro03_enrichment_batches b
    JOIN cro03_batch_memberships m ON m.batch_id=b.id JOIN cro03_source_observations o ON o.id=m.source_observation_id
    WHERE b.idempotency_key=$1`,[`csv-source-raw-v2:${claim.execution.id}:1`])).rows[0].payload;
  assert.deepEqual(retained.rawSourceRow,raw);checks++;
  const replay=await materializeCanonicalProviderImportRow(args);
  assert.deepEqual(replay.contactIds.sort((a,b)=>a-b),result.contactIds.sort((a,b)=>a-b));checks++;
  check(replay.disposition===result.disposition,"Replay preserves original row disposition");
  check(replay.businessId===result.businessId,"Replay retains the same independently verified business");
  check((await pool.query("SELECT count(*)::int n FROM business_locations WHERE business_id=$1",
    [result.businessId])).rows[0].n===1,"Location replay cannot duplicate canonical locations");
  const changed={...raw,unrecognized_provider_column:"changed"};
  await assert.rejects(materializeCanonicalProviderImportRow({...args,rawRow:changed}),
    /EVIDENCE_MISMATCH|FINGERPRINT_MISMATCH|IDEMPOTENCY_PAYLOAD_MISMATCH/);checks++;
  const badClaim=await newClaim();
  const rejected=await materializeCanonicalProviderImportRow({...args,executionId:badClaim.execution.id,
    claimToken:badClaim.claimToken!,rawRow:{...raw,name:`Flagged ${label}`,place_id:`flagged_${label}`,
      unsubscribed:"yes"}});
  check(rejected.contactIds.length===3,"Restrictive source rows retain their real contacts rather than losing their identities");
  check((await pool.query("SELECT count(*)::int n FROM contacts WHERE id=ANY($1::integer[]) AND opted_out_email=TRUE",
    [rejected.contactIds])).rows[0].n===3,"Negative email facts reach canonical consent for every supplied address");
  await pool.query("UPDATE contacts SET record_class='test' WHERE id=$1",[result.contactIds[0]]);
  check(!(await initializeImportedLinkedContactClass(result.contactIds[0])).applied,
    "Source evidence never upgrades an existing explicit non-production class");
  const missingClaim=await newClaim();
  const businessOnly=await materializeCanonicalProviderImportRow({...args,executionId:missingClaim.execution.id,
    claimToken:missingClaim.claimToken!,rawRow:{name:`No Email ${label}`,place_id:`none_${label}`,city:"Miami",state:"FL"}});
  check(businessOnly.businessId!=null && !businessOnly.contactIds.length,"Business-only rows do not invent placeholder contacts");
  await pool.query("UPDATE import_executions SET claim_token=$2 WHERE id=$1",[claim.execution.id,randomUUID()]);
  await assert.rejects(materializeCanonicalProviderImportRow(args),/AUTHORITY_FENCE_LOST|LEASE_LOST/);checks++;
  check(providerImportEmails({email:"ONE@example.com; one@EXAMPLE.com",email_status:"valid"}).length===1,
    "Address normalization ignores vendor status labels");
  assert.deepEqual(providerImportRecipient({email_1:"owner@example.com",email_1_full_name:"Jane Smith",
    email_1_title:"Owner",email_2:"office@example.com"},"owner@example.com"),
    {firstName:"Jane",lastName:"Smith",title:"Owner"});checks++;
  check(providerImportRecipient({email_1:"owner@example.com",email_1_full_name:"Jane Smith",
    email_2:"office@example.com"},"office@example.com")===null,
    "Numbered recipient semantics never borrow a different address's person");
  const legacyRaw={...raw,name:`Legacy ${label}`,place_id:`legacy_${label}`,
    email_1:`legacy.${label}@gmail.com`,email_2:"",additional_emails:""};
  const legacyClaim=await claimCsvExecution({fileHash:createHash("sha256").update(randomUUID()).digest("hex"),
    totalRows:1,actorType:"import",actorId,sourcePayload:[legacyRaw]});
  const {retainProviderImportRow}=await import("../../server/services/provider-import-evidence");
  const {computeFileHash}=await import("../../server/services/import-normalizer");
  await retainProviderImportRow({executionId:legacyClaim.execution.id,sourceRowNumber:1,
    sourceFormat:"google_maps_outscraper",actorId,rawRow:legacyRaw});
  await recordImportRowDisposition({executionId:legacyClaim.execution.id,claimToken:legacyClaim.claimToken!,
    sourceRowNumber:1,rowFingerprint:computeFileHash(Buffer.from(JSON.stringify(legacyRaw))),
    disposition:"deferred",reasonCode:"cro03_staging_review_required"});
  await completeImportExecution({executionId:legacyClaim.execution.id,claimToken:legacyClaim.claimToken!,expectedRows:1});
  const originalAccounting=(await pool.query("SELECT * FROM import_row_dispositions WHERE execution_id=$1",
    [legacyClaim.execution.id])).rows;
  const originalObservations=(await pool.query(`SELECT observation.id,observation.payload,observation.observed_at
    FROM cro03_source_observations observation JOIN cro03_batch_memberships member ON member.source_observation_id=observation.id
    JOIN cro03_enrichment_batches batch ON batch.id=member.batch_id WHERE batch.idempotency_key=$1`,
    [`csv-source:${legacyClaim.execution.id}:1`])).rows;
  process.env.NODE_ENV="production";
  process.env.REPLIT_DEPLOYMENT="1";
  process.env.RELEASE_SHA="e".repeat(40);
  process.env.SFP_PUBLISH_ARTIFACT_SHA=process.env.RELEASE_SHA;
  process.env.SFP_PUBLISH_BUILD_ID=randomUUID();
  process.env.SFP_PUBLISH_BUILT_AT=new Date().toISOString();
  const {processCanonicalImportRecoveryTick}=await import("../../server/services/canonical-import-recovery-worker");
   // The retained raw representation remains sufficient after the transient
   // execution payload is cleared; do not silently skip this historical row.
   await pool.query("UPDATE import_executions SET source_payload=NULL WHERE id=$1",[legacyClaim.execution.id]);
  const recovered=await processCanonicalImportRecoveryTick();
  check(recovered.fulfilled===1,"Completed historical staged imports are fulfilled by the real automatic existing source-item worker");
  const recoveredContact=(await pool.query("SELECT id,business_id,record_class FROM contacts WHERE email=$1",
    [legacyRaw.email_1])).rows[0];
  check(recoveredContact?.business_id && recoveredContact.record_class==="production",
    "Historical staged rows become genuinely linked, initially classified canonical contacts");
  assert.deepEqual((await pool.query("SELECT * FROM import_row_dispositions WHERE execution_id=$1",
    [legacyClaim.execution.id])).rows,originalAccounting);checks++;
  assert.deepEqual((await pool.query(`SELECT observation.id,observation.payload,observation.observed_at
    FROM cro03_source_observations observation JOIN cro03_batch_memberships member ON member.source_observation_id=observation.id
    JOIN cro03_enrichment_batches batch ON batch.id=member.batch_id WHERE batch.idempotency_key=$1`,
    [`csv-source:${legacyClaim.execution.id}:1`])).rows,originalObservations);checks++;
  const again=await processCanonicalImportRecoveryTick();
  check(again.fulfilled===0,"Completed source work is not re-materialized on the next automatic cycle");
  check((await pool.query("SELECT count(*)::int n FROM contacts WHERE email=$1",
    [legacyRaw.email_1])).rows[0].n===1,"Backlog fulfillment never duplicates contacts");
   const {createCro03SourceBatch}=await import("../../server/services/cro03/source-staging");
   const {providerCsvSourceSubject}=await import("../../server/services/cro03a/adapters");
    const {mapProviderCsvRow,importedSourceRestrictions}=await import("../../server/services/provider-import-columns");
    for(const key of ["opted_out_email","optedOutEmail","Opted Out Email"]) {
      assert.deepEqual(importedSourceRestrictions({[key]:"true",email_status:"valid"}).restrictions,["opt_out"]);checks++;
    }
   for (const sourceFormat of ["google_maps_outscraper","apollo_lead_list"]) {
     // Reproduce genuine pre-raw-v2 acquisition: mapped evidence exists, but
     // no original workbook row was retained. Never delete immutable evidence
     // to manufacture the missing-original branch.
     const missingRaw={name:`Missing original ${label} ${sourceFormat}`,email:`missing.${sourceFormat}.${label}@example.com`};
     const missingClaim=await claimCsvExecution({fileHash:createHash("sha256").update(randomUUID()).digest("hex"),
       totalRows:1,actorType:"import",actorId,sourcePayload:[missingRaw]});
     const fingerprint=computeFileHash(Buffer.from(JSON.stringify(missingRaw)));
     const draft=providerCsvSourceSubject({importExecutionId:missingClaim.execution.id,sourceRowNumber:1,
       sourceSystem:sourceFormat==="google_maps_outscraper" ? "outscraper" : "apollo",
       row:mapProviderCsvRow(missingRaw,sourceFormat)});
     await createCro03SourceBatch({idempotencyKey:`csv-source:${missingClaim.execution.id}:1`,
       actorType:"import",actorId,purpose:"staging_review",subjects:[{
         ...draft,payload:{...draft.payload,sourceFormat,rowFingerprint:fingerprint,sourceRowNumber:1},
       }]});
     await recordImportRowDisposition({executionId:missingClaim.execution.id,claimToken:missingClaim.claimToken!,
       sourceRowNumber:1,rowFingerprint:fingerprint,disposition:"deferred",reasonCode:"cro03_staging_review_required"});
     await completeImportExecution({executionId:missingClaim.execution.id,claimToken:missingClaim.claimToken!,expectedRows:1});
     await pool.query("UPDATE import_executions SET source_payload=$2::jsonb WHERE id=$1",
       [missingClaim.execution.id,sourceFormat==="apollo_lead_list" ? "[null]" : null]);
     const accounting=(await pool.query("SELECT * FROM import_row_dispositions WHERE execution_id=$1",[missingClaim.execution.id])).rows;
     const missingRecovery=await processCanonicalImportRecoveryTick();
     check(missingRecovery.held===1 && missingRecovery.fulfilled===0,`${sourceFormat}: missing originals are explicitly accounted as held`);
     const missingItem=(await pool.query(`SELECT item.state,item.terminal_code FROM cro03_enrichment_items item
       JOIN cro03_enrichment_batches batch ON batch.id=item.batch_id WHERE batch.idempotency_key=$1`,
       [`csv-source:${missingClaim.execution.id}:1`])).rows[0];
     check(missingItem.state==="blocked" && missingItem.terminal_code==="CANONICAL_IMPORT_ORIGINAL_RAW_UNAVAILABLE",
       `${sourceFormat}: mapped evidence is never represented as an original row`);
     assert.deepEqual((await pool.query("SELECT * FROM import_row_dispositions WHERE execution_id=$1",[missingClaim.execution.id])).rows,accounting);checks++;
   }
  const {readCanonicalEnrichmentStatus}=await import("../../server/services/canonical-enrichment-status");
  const status=await readCanonicalEnrichmentStatus();
   check(status.automaticProgress.validation.pending===1,"Live operating-view metrics read preparation-linked validation intents");
    check(status.importExceptions.filter(row=>row.fulfillmentState==="CANONICAL_IMPORT_ORIGINAL_RAW_UNAVAILABLE"
      && !row.originalAvailable).length===2,"Operating exceptions expose both genuinely missing-original source rows");
    check(!status.importExceptions.some(row=>row.executionId===legacyClaim.execution.id),
      "Later fulfillment does not leave the immutable original deferred row falsely listed as an active exception");
    check(status.recentImportOutcomes.some(row=>row.executionId===legacyClaim.execution.id
      && row.disposition==="deferred" && row.fulfillmentState==="CANONICAL_LOCAL_IMPORT_FULFILLED"
      && row.originalAvailable),"Operating import drill-down separates original accounting, retained evidence and later fulfillment");
  const after=(await pool.query(`SELECT
    (SELECT count(*) FROM provider_operations)::int operations,
    (SELECT count(*) FROM communication_events)::int communications,
    (SELECT count(*) FROM sfp_cohort_runs)::int cohorts`)).rows[0];
  assert.deepEqual(after,before);checks++;
  check(getBlockedCertificationNetworkAttemptCount()===0,"Intake, linking and classification are entirely local");
   const {resolveOrganization,peekOrganizationResolution}=await import("../../server/services/organization-resolver");
   const firstIdentity={canonicalName:`Identity ${label}`,googlePlaceId:`identity_${label}`,
     websiteDomain:`identity-${label}.example.com`,city:"Miami",state:"FL"};
   const firstResolution=await resolveOrganization(firstIdentity);
   check(firstResolution.kind==="created","Independent organization fixture exists");
   const conflictingIdentity={...firstIdentity,googlePlaceId:`different_${label}`};
   check((await peekOrganizationResolution(conflictingIdentity)).kind==="would_create",
     "Read-only matching keeps a distinct supported place separate despite its shared brand website");
   const separatePlace=await resolveOrganization(conflictingIdentity);
   check(separatePlace.kind==="created" && firstResolution.kind==="created"
     && separatePlace.business.id!==firstResolution.business.id,
     "Writing resolver creates the distinct supported place without merging the original location");
   const separateReplay=await resolveOrganization(conflictingIdentity);
   check(separateReplay.kind==="matched" && separatePlace.kind==="created"
     && separateReplay.business.id===separatePlace.business.id,
     "The distinct place is materialized once and its replay matches the same business");
   const contradictoryExactPlace={...firstIdentity,websiteDomain:`conflicting-${label}.example.com`};
   check((await peekOrganizationResolution(contradictoryExactPlace)).kind==="deferred",
     "Contradictory exact-place evidence remains held in the read-only preview");
   check((await resolveOrganization(contradictoryExactPlace)).kind==="deferred",
     "Contradictory exact-place evidence cannot alter the original business");
   const allFlagsClaim=await newClaim();
   const restrictiveRow={name:`All flags ${label}`,place_id:`all_flags_${label}`,city:"Miami",state:"FL",
     email:`all-flags.${label}@example.com`,do_not_contact:"yes",do_not_auto_contact:"yes",
      opted_out_email:"yes",existing_merchant_customer:"yes"};
   const allFlags=await materializeCanonicalProviderImportRow({...args,executionId:allFlagsClaim.execution.id,
     claimToken:allFlagsClaim.claimToken!,rawRow:restrictiveRow});
   check(allFlags.contactIds.length===1,"All restrictive flags still retain the genuine supplied address");
   const flags=(await pool.query(`SELECT do_not_contact,do_not_auto_contact,opted_out_email,existing_merchant_customer
     FROM contacts WHERE id=$1`,[allFlags.contactIds[0]])).rows[0];
   check(flags.do_not_contact && flags.do_not_auto_contact && flags.opted_out_email && flags.existing_merchant_customer,
     "Independent negative/customer dimensions are all applied, not collapsed into one flag");
   const {storage}=await import("../../server/storage");
   const {processPersistedCsvImport}=await import("../../server/services/csv-import-processor");
   const genericRows=[
     {companyName:`Manual business ${label}`,city:"Miami",state:"FL"},
      {"First Name":"Genuine person","Phone":`305${String(Date.now()%10000000).padStart(7,"0")}`,
        "Do Not Contact":"yes",do_not_auto_contact:"true",optedOutEmail:"yes",
        existing_merchant_customer:"yes",email_status:"valid"},
     {firstName:"Insufficient identity"},
   ];
   const genericClaim=await claimCsvExecution({fileHash:createHash("sha256").update(randomUUID()).digest("hex"),
     totalRows:genericRows.length,actorType:"user",actorId,sourcePayload:genericRows});
   const genericRecord=await storage.createCsvImport({executionId:genericClaim.execution.id,
     fileName:"manual.csv",sourceFormat:"generic_csv",importSource:"generic_csv",
     totalRows:genericRows.length,status:"processing",importedBy:actorId});
   await processPersistedCsvImport({records:genericRows as Array<Record<string,string>>,
     executionClaim:genericClaim,importRecord:genericRecord,sourceFormat:"generic_csv",
     actor:{actorType:"user",actorId},filename:"manual.csv"});
   check((await pool.query(`SELECT count(*)::int n FROM contacts WHERE import_batch_id=$1`,
     [genericClaim.execution.id])).rows[0].n===1,"Generic company-only and identifier-poor rows never create placeholder contacts");
    const manualContact=(await pool.query(`SELECT email,first_name,do_not_contact,do_not_auto_contact,
      opted_out_email,existing_merchant_customer,email_status FROM contacts WHERE import_batch_id=$1`,
     [genericClaim.execution.id])).rows[0];
   check(!manualContact.email && manualContact.first_name==="Genuine person","Phone-only people retain their real identity without an invented email");
    check(manualContact.do_not_contact && manualContact.do_not_auto_contact && manualContact.opted_out_email
      && manualContact.existing_merchant_customer && manualContact.email_status!=="valid",
      "Generic raw-header imports preserve all independent restrictions/customer facts without accepting vendor validity");
   check((await pool.query(`SELECT count(*)::int n FROM import_row_dispositions WHERE execution_id=$1`,
     [genericClaim.execution.id])).rows[0].n===3,"Generic business/person/exception rows all receive immutable accounting");
    assert.deepEqual((await pool.query(`SELECT
      (SELECT count(*) FROM provider_operations)::int operations,
      (SELECT count(*) FROM communication_events)::int communications,
      (SELECT count(*) FROM sfp_cohort_runs)::int cohorts`)).rows[0],before);checks++;
    check(getBlockedCertificationNetworkAttemptCount()===0,"The complete generic/provider/recovery fixture remains zero-egress");
  // More missing originals than one tick may inspect: bounded accounting must
  // make forward progress without changing original dispositions or evidence.
  const boundedRows=Array.from({length:12},(_,index)=>({
    name:`Bounded missing ${label} ${index}`,place_id:`bounded_${label}_${index}`,
    city:"Miami",state:"FL",email:`bounded.${index}.${label}@example.com`,
  }));
  const boundedClaim=await claimCsvExecution({
    fileHash:createHash("sha256").update(randomUUID()).digest("hex"),
    totalRows:boundedRows.length,actorType:"import",actorId,sourcePayload:boundedRows,
  });
  for (const [index,boundedRaw] of boundedRows.entries()) {
    const draft=providerCsvSourceSubject({importExecutionId:boundedClaim.execution.id,
      sourceRowNumber:index+1,sourceSystem:"outscraper",
      row:mapProviderCsvRow(boundedRaw,"google_maps_outscraper")});
    const rowFingerprint=computeFileHash(Buffer.from(JSON.stringify(boundedRaw)));
    await createCro03SourceBatch({
      idempotencyKey:`csv-source:${boundedClaim.execution.id}:${index+1}`,
      actorType:"import",actorId,purpose:"staging_review",
      subjects:[{...draft,payload:{...draft.payload,sourceFormat:"google_maps_outscraper",
        rowFingerprint,sourceRowNumber:index+1}}],
    });
    await recordImportRowDisposition({
      executionId:boundedClaim.execution.id,claimToken:boundedClaim.claimToken!,
      sourceRowNumber:index+1,rowFingerprint,disposition:"deferred",
      reasonCode:"cro03_staging_review_required",
    });
  }
  await completeImportExecution({executionId:boundedClaim.execution.id,
    claimToken:boundedClaim.claimToken!,expectedRows:boundedRows.length});
  await pool.query("UPDATE import_executions SET source_payload=NULL WHERE id=$1",[boundedClaim.execution.id]);
  const boundedAccounting=(await pool.query(
    "SELECT * FROM import_row_dispositions WHERE execution_id=$1 ORDER BY source_row_number",
    [boundedClaim.execution.id])).rows;
  await assert.rejects(processCanonicalImportRecoveryTick({maxItems:251}),
    /CANONICAL_IMPORT_RECOVERY_INVALID_TICK_BUDGET/);checks++;
  await assert.rejects(processCanonicalImportRecoveryTick({maxDurationMs:30_001}),
    /CANONICAL_IMPORT_RECOVERY_INVALID_TICK_BUDGET/);checks++;
  const boundedFirst=await processCanonicalImportRecoveryTick({maxItems:5});
  check(boundedFirst.held===5 && boundedFirst.fulfilled===0,
    "Missing-original accounting cannot exceed a reduced per-tick execution budget");
  const boundedSecond=await processCanonicalImportRecoveryTick();
  check(boundedSecond.held===7 && boundedSecond.fulfilled===0,
    "Default recovery advances beyond the old five-row ceiling without revisiting already-accounted exceptions");
  const boundedThird=await processCanonicalImportRecoveryTick();
  check(!boundedThird.ran,"Missing-original exception replay performs no additional work");
  await pool.query("UPDATE import_executions SET source_payload=$2::jsonb WHERE id=$1",
    [boundedClaim.execution.id,JSON.stringify([boundedRows[0]])]);
  // Availability is now rechecked on bounded due-item opportunities instead of
  // opening every original workbook during scalar selection. Advance only this
  // disposable fixture's due time to exercise its next ordinary opportunity.
  await pool.query(`UPDATE cro03_enrichment_items item SET next_attempt_at=clock_timestamp()-interval '1 second'
    FROM cro03_enrichment_batches batch WHERE batch.id=item.batch_id AND batch.idempotency_key=$1`,
    [`csv-source:${boundedClaim.execution.id}:1`]);
  const restored=await processCanonicalImportRecoveryTick();
  check(restored.fulfilled===1 && restored.held===0,
    "A genuinely restored original can recover through its existing source item");
  assert.deepEqual((await pool.query(
    "SELECT * FROM import_row_dispositions WHERE execution_id=$1 ORDER BY source_row_number",
    [boundedClaim.execution.id])).rows,boundedAccounting);checks++;
  check((await pool.query("SELECT id FROM contacts WHERE email=$1",
    [boundedRows[0].email])).rows.length===1,"Restored original creates one genuine contact");
  check(!(await processCanonicalImportRecoveryTick()).ran,
    "Restored-original replay neither duplicates the contact nor repeats missing-original accounting");
  const {assertSystemLinkDatabaseGuard}=await import("../../server/services/commercial-link-authority");
  const guardRollback=new Error("PREPARED_NATIVE_GUARD_ROLLBACK");
  await assert.rejects(db.transaction(async tx=>{
    await assertSystemLinkDatabaseGuard(tx,{prepared:true});
    await tx.execute(sql`ALTER TABLE contact_business_link_decisions
      DISABLE TRIGGER contact_business_link_review_contract`);
    await assert.rejects(assertSystemLinkDatabaseGuard(tx,{prepared:true}),
      /COMMERCIAL_SYSTEM_LINK_DATABASE_GUARD_MISSING/);checks++;
    throw guardRollback;
  }),(error:unknown)=>error===guardRollback);checks++;
  await db.transaction(tx=>assertSystemLinkDatabaseGuard(tx,{prepared:true}));checks++;
  // A spreadsheet-sized genuine deferred backlog, not scalar cursor fixtures.
  // Run the same bounded importer and BullMQ continuation policy used in prod.
  const bulkRows=Array.from({length:1472},(_,index)=>({
    name:`Bulk ${label} ${index}`,place_id:`bulk_${label}_${index}`,
    city:"Miami",state:"FL",email:`bulk.${index}.${label}@example.com`,
  }));
  const bulkClaim=await claimCsvExecution({
    fileHash:createHash("sha256").update(randomUUID()).digest("hex"),
    totalRows:bulkRows.length,actorType:"import",actorId,sourcePayload:bulkRows,
  });
  for (const [index,bulkRaw] of bulkRows.entries()) {
    const draft=providerCsvSourceSubject({importExecutionId:bulkClaim.execution.id,
      sourceRowNumber:index+1,sourceSystem:"outscraper",
      row:mapProviderCsvRow(bulkRaw,"google_maps_outscraper")});
    const rowFingerprint=computeFileHash(Buffer.from(JSON.stringify(bulkRaw)));
    await createCro03SourceBatch({
      idempotencyKey:`csv-source:${bulkClaim.execution.id}:${index+1}`,
      actorType:"import",actorId,purpose:"staging_review",
      subjects:[{...draft,payload:{...draft.payload,sourceFormat:"google_maps_outscraper",
        rowFingerprint,sourceRowNumber:index+1}}],
    });
    await recordImportRowDisposition({executionId:bulkClaim.execution.id,
      claimToken:bulkClaim.claimToken!,sourceRowNumber:index+1,rowFingerprint,
      disposition:"deferred",reasonCode:"cro03_staging_review_required"});
  }
  await completeImportExecution({executionId:bulkClaim.execution.id,
    claimToken:bulkClaim.claimToken!,expectedRows:bulkRows.length});
  console.log("BULK: 1472 genuine deferred rows staged; starting serial continuation worker");
  const {Queue,Worker}=await import("bullmq");
  const {getRedisConnection,getBullMqPrefixForQueue,getSharedRedisClient}=await import("../../server/services/queue-connection");
  const {canonicalImportContinuationOptions}=await import("../../server/services/canonical-import-recovery-scheduling");
  const {getQueuesForCapabilityGroups}=await import("../../server/services/background-profile");
  check(getQueuesForCapabilityGroups(["sfp-continuous-discovery"]).includes("canonical-import-recovery"),
    "The existing production selective profile starts independent local recovery");
  const connection=await getRedisConnection();
  const bulkQueue=new Queue("canonical-import-recovery",{connection,
    prefix:getBullMqPrefixForQueue("canonical-import-recovery")});
  let bulkFulfilled=0,bulkBatches=0,firstBatchSize=0;
  const bulkStarted=Date.now();
  let finish!:()=>void,fail!:(error:Error)=>void;
  const completed=new Promise<void>((resolve,reject)=>{finish=resolve;fail=reject;});
  const worker=new Worker("canonical-import-recovery",async job=>{
    const result=await processCanonicalImportRecoveryTick();
    bulkBatches++;
    if (bulkBatches===1) firstBatchSize=result.fulfilled;
    bulkFulfilled+=result.fulfilled;
    console.log(`BULK batch ${bulkBatches}: ${result.fulfilled} fulfilled; ${bulkFulfilled}/1472 total`);
    if (bulkFulfilled===bulkRows.length) {finish();return;}
    if (!result.ran || !result.budgetExhausted)
      throw new Error(`BULK_RECOVERY_STOPPED:${JSON.stringify(result)}:${bulkFulfilled}`);
    await bulkQueue.add("continue",{},canonicalImportContinuationOptions(job.id));
  },{connection,prefix:getBullMqPrefixForQueue("canonical-import-recovery"),concurrency:1});
  worker.on("failed",(_job,error)=>fail(error));
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    await bulkQueue.add("tick",{}, {removeOnComplete:true,removeOnFail:true});
    await Promise.race([completed,new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(new Error("BULK_RECOVERY_TIMEOUT")),600_000);
    })]);
    check(firstBatchSize>1,"A real bounded cycle processes multiple rows rather than one, even under concurrent certification load");
    check(bulkBatches>=6,"Actual BullMQ continuations advance beyond two batches without active-ID deduplication");
    check(bulkFulfilled===1472,"The real local worker fulfills the entire spreadsheet-sized backlog");
    const bulkCounts=(await pool.query(`SELECT
      (SELECT count(*)::int FROM contacts WHERE email LIKE $1) contacts,
      (SELECT count(*)::int FROM cro03_enrichment_items i JOIN cro03_enrichment_batches b ON b.id=i.batch_id
        WHERE b.idempotency_key LIKE $2 AND i.terminal_code='CANONICAL_LOCAL_IMPORT_FULFILLED') fulfilled,
      (SELECT count(*)::int FROM import_row_dispositions
        WHERE execution_id=$3 AND disposition='deferred') original_deferred`,
      [`bulk.%.${label}@example.com`,`csv-source:${bulkClaim.execution.id}:%`,bulkClaim.execution.id])).rows[0];
    assert.deepEqual(bulkCounts,{contacts:1472,fulfilled:1472,original_deferred:1472});checks++;
    check(!(await processCanonicalImportRecoveryTick()).ran,
      "A completed bulk recovery replays as a no-op without creating more contacts");
    console.log(`BULK: ${bulkFulfilled} native rows / ${bulkBatches} serial batches / ${Date.now()-bulkStarted}ms; first batch ${firstBatchSize}`);
  } finally {
    if (timer) clearTimeout(timer);
    await worker.close();
    await bulkQueue.obliterate({force:true});
    await bulkQueue.close();
    await getSharedRedisClient()?.quit();
  }
  assert.deepEqual((await pool.query(`SELECT
    (SELECT count(*) FROM provider_operations)::int operations,
    (SELECT count(*) FROM communication_events)::int communications,
    (SELECT count(*) FROM sfp_cohort_runs)::int cohorts`)).rows[0],before);checks++;
  check(getBlockedCertificationNetworkAttemptCount()===0,
    "Bounded recovery and genuine-original restoration remain zero-egress");
  console.log(`PASS: ${checks} canonical provider intake/native/replay checks; no I/O, validation purchases, cohorts or messages`);
} finally {await pool.end();}