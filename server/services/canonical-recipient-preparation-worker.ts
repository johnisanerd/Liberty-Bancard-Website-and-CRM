import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { effectiveBusinessVerticalSql } from "@shared/effective-vertical";
import { contactTargetVerticalSql } from "@shared/contact-vertical-taxonomy";
import { assertCanonicalPreparationDatabaseGuard,prepareCanonicalRecipient } from "./canonical-recipient-preparation";
import { resolveGeographyFromCandidates } from "./cro03/sfp-geography-resolver";
import { claimSfpRuntimeDeploymentOwner,lockCurrentSfpRuntimeOwner } from "./cro03/sfp-provider-operations";
import { runCanonicalTransaction,boundCanonicalWriteTransaction } from "./canonical-transaction-retry";
import {assertCanonicalPreparationLease,checkpointCanonicalPreparationLease} from "./canonical-preparation-lease";

const KEY="canonical_recipient_preparation_cursor";
/** Priority-lane 25-row pages per tick (a single page per tick took 2+ days per full cycle). */
const MAX_PRIORITY_PAGES_PER_TICK=4;
/** Time each of the two fair-share lanes is guaranteed per pass, whatever the completion and stale-package lanes
 * did before them. Before this reservation both lanes could receive a zero-length window: the slow lanes ran up to
 * the shared deadline first, so the priority cursor sat still for days while the backlog it exists to reach grew. */
/** Contact uploads completed within this window form the upload cohort that preparation reaches directly. */
export const UPLOAD_COHORT_WINDOW_DAYS=30;
/** After a full cohort pass, held contacts (unresolved geography, no program binding) are not re-read for this long. */
export const UPLOAD_COHORT_REVISIT_HOURS=6;
const COHORT_PAGE=25;
/** Lease/cursor renewal cadence inside qualification; the lease lasts two minutes so this is a wide margin. */
const CHECKPOINT_EVERY_MS=10_000;
const EMAIL_SHAPE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PREPARATION_LANE_RESERVES={priorityMs:75_000,populationMs:15_000} as const;
export type PreparationLane="completion"|"stale"|"population"|"priority";
/** Pure scheduling rule for one lane's processing window (an absolute epoch-millisecond deadline).
 *  - completion/stale never run into the time held back for the two reserved lanes;
 *  - population keeps its reserve even if earlier lanes overran, and stops where the priority reserve begins;
 *  - priority always keeps its reserve, even when earlier lanes overran the whole pass.
 *  A reserve is a floor measured from the moment the lane starts, so overshoot inside one slow contact (a started
 *  contact finishes) can delay a lane but never remove its window. */
export function preparationLaneDeadline(lane:PreparationLane,input:{
  now:number;passDeadline:number;capMs:number;priorityReserveMs:number;populationReserveMs:number;
}):number {
  const {now,passDeadline,capMs,priorityReserveMs,populationReserveMs}=input;
  const capped=now+capMs;
  switch (lane) {
    case "completion":
    case "stale": return Math.min(passDeadline-priorityReserveMs-populationReserveMs,capped);
    case "population": return Math.max(Math.min(passDeadline-priorityReserveMs,capped),now+populationReserveMs);
    case "priority": return Math.max(Math.min(passDeadline,capped),now+priorityReserveMs);
  }
}
const rows=(result:any):any[]=>result?.rows ?? result ?? [];
type Cursor={afterContactId:number;cycles:number;scanned:number;prepared:number;held:number;
  reasons:Record<string,number>;leaseToken:string|null;leaseUntil:string|null;lastCycleAt:string|null;
  priority?:{afterContactId:number;cycles:number;scanned:number;prepared:number;held:number;
    reasons:Record<string,number>;lastCycleAt:string|null};
  cohort?:{afterContactId:number;cycles:number;scanned:number;prepared:number;held:number;
    reasons:Record<string,number>;lastCycleAt:string|null};};

/** Local selection only. Uses the existing published owner, enrollment ledger
 * and queue tick. Provider pauses never gate this pass; it cannot send or spend. */
export async function processCanonicalRecipientPreparationTick(
  budget:{maxPopulationPages?:number;staleBudgetMs?:number;priorityReserveMs?:number;populationReserveMs?:number;
    /** Base length of the shared pass window before the stale extra and lane reserves; certification only. */
    passBaseMs?:number;
    /** Run only the upload-cohort lane (local recovery scheduling); the other lanes and their cursors are untouched. */
    uploadCohortOnly?:boolean;
    /** Time window for the cohort-only run. */
    cohortBudgetMs?:number}={},
) {
  const priorityReserveMs=budget.priorityReserveMs ?? PREPARATION_LANE_RESERVES.priorityMs;
  const populationReserveMs=budget.populationReserveMs ?? PREPARATION_LANE_RESERVES.populationMs;
  const passBaseMs=budget.passBaseMs ?? 90_000;
  if (!Number.isInteger(priorityReserveMs) || priorityReserveMs<0 || priorityReserveMs>120_000 ||
      !Number.isInteger(populationReserveMs) || populationReserveMs<0 || populationReserveMs>120_000 ||
      !Number.isInteger(passBaseMs) || passBaseMs<1_000 || passBaseMs>300_000) {
    throw new Error("CANONICAL_PREPARATION_INVALID_LANE_RESERVE");
  }
  const cohortBudgetMs=budget.cohortBudgetMs ?? 4*60_000;
  if (!Number.isInteger(cohortBudgetMs) || cohortBudgetMs<1_000 || cohortBudgetMs>10*60_000) {
    throw new Error("CANONICAL_PREPARATION_INVALID_COHORT_BUDGET");
  }
  const maxPopulationPages=budget.maxPopulationPages ?? 20;
  if (!Number.isInteger(maxPopulationPages) || maxPopulationPages<1 || maxPopulationPages>20) {
    throw new Error("CANONICAL_PREPARATION_INVALID_TICK_BUDGET");
  }
  // Each re-preparation costs several seconds against the production database, so the stale-package lane's time
  // share is adjustable; the tick deadline grows by the same extra so population coverage is never squeezed out.
  const staleBudgetMs=budget.staleBudgetMs ?? 30_000;
  if (!Number.isInteger(staleBudgetMs) || staleBudgetMs<1_000 || staleBudgetMs>240_000) {
    throw new Error("CANONICAL_PREPARATION_INVALID_STALE_BUDGET");
  }
  const actorId="system:canonical-recipient-preparation";
  const owner=await runCanonicalTransaction("preparation_owner_claim",claimSfpRuntimeDeploymentOwner);
  const token=randomUUID();
  const fence=async(tx:any)=>{
    await boundCanonicalWriteTransaction(tx);
    const live=await lockCurrentSfpRuntimeOwner(tx);
    if (live.ownerEpoch!==owner.ownerEpoch || live.ownerToken!==owner.ownerToken) {
      throw new Error("CANONICAL_PREPARATION_RUNTIME_OWNER_CHANGED");
    }
    await assertCanonicalPreparationDatabaseGuard(tx);
  };
  const claimed=await runCanonicalTransaction("preparation_cursor_claim",()=>db.transaction(async tx=>{
    await fence(tx);
    const initial:Cursor={afterContactId:0,cycles:0,scanned:0,prepared:0,held:0,reasons:{},
      leaseToken:null,leaseUntil:null,lastCycleAt:null};
    await tx.execute(sql`INSERT INTO system_settings(key,value,updated_at)
      VALUES(${KEY},${JSON.stringify(initial)}::jsonb,NOW()) ON CONFLICT(key) DO NOTHING`);
    return rows(await tx.execute(sql`UPDATE system_settings SET
      value=jsonb_set(jsonb_set(value,'{leaseToken}',to_jsonb(${token}::text)),
        '{leaseUntil}',to_jsonb((clock_timestamp()+INTERVAL '2 minutes')::text)),updated_at=NOW()
      WHERE key=${KEY} AND (value->>'leaseUntil' IS NULL
        OR (value->>'leaseUntil')::timestamptz<=clock_timestamp()) RETURNING value`))[0]?.value as Cursor|undefined;
  }));
  if (!claimed) return {ran:false,reason:"current_preparation_pass_owned"};
  const state=claimed;
  state.priority ??= {afterContactId:0,cycles:0,scanned:0,prepared:0,held:0,reasons:{},lastCycleAt:null};
  const priorityCursor=state.priority;
  state.cohort ??= {afterContactId:0,cycles:0,scanned:0,prepared:0,held:0,reasons:{},lastCycleAt:null};
  const cohortCursor=state.cohort;
  const guard=async(tx:any)=>{
    await fence(tx);
    await assertCanonicalPreparationLease(tx,KEY,token);
  };
  let lastCheckpointAt=Date.now();
  const checkpoint=async(release=false)=>{
    await runCanonicalTransaction(release ? "preparation_release" : "preparation_checkpoint",()=>db.transaction(async tx=>{
      await fence(tx);
      await checkpointCanonicalPreparationLease(tx,KEY,token,state,release);
    }));
    lastCheckpointAt=Date.now();
  };
  // The reserved lane windows are added to the pass, so the slow lanes keep the share they always had.
  const deadline=Date.now()+passBaseMs+Math.max(0,staleBudgetMs-30_000)+priorityReserveMs+populationReserveMs;
  const laneDeadline=(lane:PreparationLane,capMs:number)=>preparationLaneDeadline(lane,
    {now:Date.now(),passDeadline:deadline,capMs,priorityReserveMs,populationReserveMs});
  const bindingJoins=sql`JOIN businesses b ON b.id=c.business_id
    JOIN sfp_programs p ON p.is_active AND p.taxonomy_version=2
      AND ${sql.raw(effectiveBusinessVerticalSql("b"))}=ANY(p.vertical_ids)
    JOIN follow_up_sequences seq ON seq.retired_at IS NULL AND (
      seq.trigger_config->>'canonicalProgramId'=p.id::text
      AND seq.trigger_config->'canonicalVerticals' ? ${sql.raw(effectiveBusinessVerticalSql("b"))}
      OR EXISTS(SELECT 1 FROM sfp_campaign_package_versions pkg
        WHERE pkg.sequence_id=seq.id AND pkg.lifecycle_state='current'
          AND ${sql.raw(contactTargetVerticalSql("pkg.vertical"))}=${sql.raw(effectiveBusinessVerticalSql("b"))})
    )`;
  // Diagnostic stopwatch per lane (milliseconds). Read-only observation of where a tick spends its time.
  const timingsByLane:Record<string,Record<string,number>>={completion:{},stale:{},priority:{},population:{},cohort:{}};
  let active=timingsByLane.population;
  const timed=async<T>(phase:string,work:()=>Promise<T>):Promise<T>=>{
    const startedAt=Date.now();
    try {return await work();} finally {active[phase]=(active[phase] ?? 0)+Date.now()-startedAt;}
  };
  // Renew the lease/cursor at most this often. Each renewal is a full guarded transaction, and qualification used to
  // pay two of them per recipient (plus one more after every prepared contact).
  const throttledCheckpoint=async()=>{
    if (Date.now()-lastCheckpointAt>=CHECKPOINT_EVERY_MS) await timed("worker_checkpoint",checkpoint);
  };
  const processPage=async(contacts:any[],progress:NonNullable<Cursor["priority"]>,pageDeadline=deadline,
    onOutcome?:(contactId:number,prepared:boolean,reason:string|null)=>void)=>{
    let examined=0,prepared=0;
    const laneTimings=active;
    // This is candidate retrieval, never write authority. Unbound contacts need
    // no per-row owner-locked transaction; genuine prepared slots still retire
    // under the existing guard, and every actual preparation rechecks its
    // binding and native/runtime authority before writing.
    const bindings=contacts.length ? rows(await timed("bindings_query",()=>db.execute(sql`
      SELECT DISTINCT c.id AS contact_id,p.id AS program_id,seq.id AS sequence_id
      FROM contacts c ${bindingJoins}
      WHERE c.id IN (${sql.join(contacts.map(contact=>sql`${Number(contact.id)}`),sql`,`)})
        AND c.archived_at IS NULL AND c.do_not_contact IS NOT TRUE
        AND b.record_class='canonical' AND c.email IS NOT NULL
      ORDER BY c.id,p.id,seq.id
    `))) : [];
    const bindingsByContact=new Map<number,Map<string,number[]>>();
    for (const binding of bindings) {
      const contactId=Number(binding.contact_id),programId=String(binding.program_id);
      const programs=bindingsByContact.get(contactId) ?? new Map<string,number[]>();
      programs.set(programId,[...(programs.get(programId) ?? []),Number(binding.sequence_id)]);
      bindingsByContact.set(contactId,programs);
    }
    // Local pre-screen, one read per page. A contact whose own business has no verified relationship, no resolvable
    // in-territory geography or no usable address can only end in the same no-write hold the preparation writer
    // reaches after its (expensive) qualification and lock phases, so the page records that hold directly. The writer
    // still performs every one of these checks under lock for any contact that passes the screen.
    const screenedHold=new Map<number,string>();
    if (bindingsByContact.size) {
      const facts=rows(await timed("screen_query",()=>db.execute(sql`
        SELECT c.id AS contact_id,c.email,b.city,b.state,b.postal_code,
          EXISTS(SELECT 1 FROM contact_business_link_decisions l WHERE l.contact_id=c.id AND l.business_id=c.business_id
            AND l.decision='verified' AND l.superseded_at IS NULL) AS has_link,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('id',bl.id,'is_primary',bl.is_primary,'city',bl.city,
              'state',bl.state,'postal_code',bl.postal_code,'county_fips',bl.county_fips) ORDER BY bl.id)
            FROM business_locations bl WHERE bl.business_id=b.id),'[]'::jsonb) AS locations
        FROM contacts c JOIN businesses b ON b.id=c.business_id AND b.record_class='canonical'
        WHERE c.id IN (${sql.join([...bindingsByContact.keys()].map(id=>sql`${id}`),sql`,`)})`)));
      for (const fact of facts) {
        if (fact.has_link!==true) {screenedHold.set(Number(fact.contact_id),"INDEPENDENT_BUSINESS_AFFILIATION_REQUIRED");continue;}
        const locations:any[]=Array.isArray(fact.locations) ? fact.locations : [];
        const geography=resolveGeographyFromCandidates([
          ...locations.map(location=>({
            locationId:Number(location.id),isPrimary:location.is_primary===true,
            city:location.city,state:location.state,postalCode:location.postal_code,countyFips:location.county_fips,
          })),
          {locationId:null,isPrimary:false,city:fact.city,state:fact.state,postalCode:fact.postal_code,countyFips:null},
        ]);
        if (!geography.eligible || !geography.countyFips) {
          screenedHold.set(Number(fact.contact_id),"CURRENT_GEOGRAPHY_UNRESOLVED_OR_EXCLUDED");continue;
        }
        if (!EMAIL_SHAPE.test(String(fact.email ?? "").trim().toLowerCase())) {
          screenedHold.set(Number(fact.contact_id),"AVAILABLE_EMAIL_REQUIRED");
        }
      }
    }
    for (const contact of contacts) {
      if (Date.now()>=pageDeadline) break;
      // Unbound population rows do not regain a per-row authority transaction.
      // Renew between bounded pages/time slices; actual effects checkpoint
      // independently before/after qualification and after their commits.
      await throttledCheckpoint();
      // Include unavailable/changed recipients: stale paused slots must retire,
      // so suppressions and affiliation changes cannot strand the allowance.
      if (contact.has_preparation===true) await timed("retirement",()=>runCanonicalTransaction("preparation_retirement",()=>db.transaction(async tx=>{
        await guard(tx);
        const obsolete=rows(await tx.execute(sql`SELECT i.id,i.enrollment_id
          FROM cr04_enrollment_intents i LEFT JOIN contacts c ON c.id=i.contact_id
          LEFT JOIN sfp_programs p ON p.id=i.program_id
          LEFT JOIN businesses b ON b.id=i.business_id
          WHERE i.contact_id=${Number(contact.id)}
            AND i.preparation_state IN ('pending_validation','ready_held')
            AND (c.id IS NULL OR c.record_class IS DISTINCT FROM 'production'
              OR c.archived_at IS NOT NULL OR c.do_not_contact IS TRUE
              OR c.do_not_auto_contact IS TRUE OR c.opted_out_email IS TRUE
              OR c.email_status IN ('invalid','bounced','unsafe','opted_out')
              OR c.business_id IS DISTINCT FROM i.business_id OR p.is_active IS NOT TRUE
              OR i.preparation_snapshot->>'policyVersion' IS DISTINCT FROM p.policy_version::text
              OR i.preparation_snapshot->>'businessSourceFingerprint' IS DISTINCT FROM
                md5(to_jsonb(b)::text||COALESCE((SELECT jsonb_agg(to_jsonb(bl) ORDER BY bl.id)::text
                  FROM business_locations bl WHERE bl.business_id=b.id),'[]'))
              OR encode(sha256(convert_to(lower(trim(c.email)),'UTF8')),'hex')
                IS DISTINCT FROM i.normalized_email_hash)
          FOR UPDATE OF i`));
        for (const intent of obsolete) {
          await tx.execute(sql`UPDATE sequence_enrollments SET status='cancelled',updated_at=NOW()
            WHERE id=${intent.enrollment_id} AND status IN ('paused','active')
              AND metadata->>'canonicalPreparationId'=${String(intent.id)}`);
          await tx.execute(sql`UPDATE cr04_enrollment_intents SET preparation_state='exception',
            enrollment_id=NULL,reason_code='CURRENT_RECIPIENT_FACTS_CHANGED' WHERE id=${String(intent.id)}::uuid`);
        }
        await guard(tx);
      })));
      const programs=bindingsByContact.get(Number(contact.id)) ?? new Map<string,number[]>();
      let advanced=false,reason="NO_CURRENT_PROGRAM_BINDING_OR_AVAILABLE_EMAIL";
      const screened=screenedHold.get(Number(contact.id));
      if (screened) reason=screened;
      else for (const [programId,sequences] of programs) {
        if (Date.now()>=pageDeadline) break;
        if (sequences.length!==1) {reason="PROGRAM_BINDING_AMBIGUOUS";continue;}
        try {
          const result=await prepareCanonicalRecipient({
            contactId:Number(contact.id),programId,sequenceId:sequences[0],
            actor:{role:"admin",actorId,email:null},source:"canonical_automatic_selection",beforeWrite:guard,
            checkpoint:throttledCheckpoint,timings:laneTimings,
          });
          if (result.enrollmentId) {advanced=true;prepared++;}
          else reason=result.reasonCode;
        } catch(error:any) {
          const message=String(error?.cause?.message ?? error?.message);
          if (!message.includes("CANONICAL_PREPARATION_RECIPIENT_CAPACITY")) throw error;
          reason="USEFUL_RECIPIENT_ALLOWANCE_FILLED";
        }
      }
      progress.afterContactId=Number(contact.id);progress.scanned++;examined++;
      laneTimings.contacts=(laneTimings.contacts ?? 0)+1;
      if (advanced) progress.prepared++;
      else {progress.held++;progress.reasons[reason]=(progress.reasons[reason] ?? 0)+1;}
      onOutcome?.(Number(contact.id),advanced,advanced ? null : reason);
      await throttledCheckpoint();
    }
    await timed("worker_checkpoint",checkpoint);
    return {examined,prepared};
  };
  // Upload-cohort lane. Contacts from contact uploads completed within UPLOAD_COHORT_WINDOW_DAYS that have never been
  // examined (no preparation row of any state) are reached directly instead of waiting for an unrelated ID-ordered
  // sweep. It has its own cursor, so the population and priority cursors are never moved or reset; it uses the same
  // page processor, therefore the same canonical writer, guards and lease. Contacts that end in a no-write hold
  // (no program binding, unresolved geography, ...) get a durable per-contact hold record, because they have no
  // preparation row to show why they stopped.
  const runCohortLane=async(laneDeadlineAt:number)=>{
    const out={examined:0,prepared:0,held:0,pages:0,more:false,cooldown:false};
    const cooldownMs=UPLOAD_COHORT_REVISIT_HOURS*3_600_000;
    if (cohortCursor.afterContactId===0 && cohortCursor.lastCycleAt
        && Date.now()-Date.parse(cohortCursor.lastCycleAt)<cooldownMs) {out.cooldown=true;return out;}
    while (Date.now()<laneDeadlineAt) {
      const page=rows(await db.execute(sql`SELECT m.contact_id AS id,FALSE AS has_preparation FROM (
          SELECT DISTINCT cse.contact_id FROM contact_source_events cse
          JOIN import_executions e ON e.id=cse.import_execution_id AND e.import_type='csv_contact'
            AND e.status='completed' AND e.completed_at>NOW()-(${UPLOAD_COHORT_WINDOW_DAYS} * INTERVAL '1 day')
          WHERE cse.contact_id>${cohortCursor.afterContactId}) m
        JOIN contacts c ON c.id=m.contact_id AND c.record_class='production' AND c.archived_at IS NULL
        WHERE NOT EXISTS(SELECT 1 FROM cr04_enrollment_intents i WHERE i.contact_id=c.id)
        ORDER BY m.contact_id LIMIT ${COHORT_PAGE}`));
      active=timingsByLane.cohort;
      const holds:Array<{id:number;reason:string}>=[];
      const result=await processPage(page,cohortCursor,laneDeadlineAt,(contactId,advanced,reason)=>{
        if (!advanced && reason) holds.push({id:contactId,reason});
      });
      out.pages++;out.examined+=result.examined;out.prepared+=result.prepared;out.held+=holds.length;
      if (holds.length) {
        await timed("hold_records",()=>db.execute(sql`
          INSERT INTO audit_logs(user_id,action,entity_type,entity_id,entity_key,details,actor_type,actor_id)
          SELECT 'system:canonical-recipient-preparation','canonical_preparation.upload_cohort_hold','contact',v.id,v.reason,
            jsonb_build_object('contactId',v.id,'reason',v.reason,'lane','upload_cohort','cohortCycle',${cohortCursor.cycles}::int),
            'system','canonical-recipient-preparation'
          FROM (VALUES ${sql.join(holds.map(h=>sql`(${h.id}::integer,${h.reason}::text)`),sql`, `)}) v(id,reason)
          WHERE NOT EXISTS(SELECT 1 FROM audit_logs a WHERE a.action='canonical_preparation.upload_cohort_hold'
            AND a.entity_id=v.id AND a.entity_key=v.reason AND a.created_at>NOW()-INTERVAL '24 hours')`));
      }
      if (result.examined===page.length && page.length<COHORT_PAGE) {
        cohortCursor.afterContactId=0;cohortCursor.cycles++;cohortCursor.lastCycleAt=new Date().toISOString();
        return out;
      }
      if (result.examined!==page.length) {out.more=true;return out;} // deadline reached inside the page
    }
    out.more=true;
    return out;
  };
  let failed=false;
  try {
    if (budget.uploadCohortOnly) {
      const cohort=await runCohortLane(Date.now()+cohortBudgetMs);
      return {ran:true,uploadCohortOnly:true,cohortCycles:cohortCursor.cycles,uploadCohort:cohort,
        timingsMs:Object.fromEntries(Object.entries(timingsByLane).filter(([,v])=>Object.keys(v).length>0))};
    }
    const populationPage=async()=>rows(await db.execute(sql`SELECT c.id,EXISTS (
        SELECT 1 FROM cr04_enrollment_intents owned WHERE owned.contact_id=c.id
          AND owned.preparation_state IN ('pending_validation','ready_held')) AS has_preparation
      FROM contacts c
      WHERE c.id>${state.afterContactId} AND (c.record_class='production' OR EXISTS (
        SELECT 1 FROM cr04_enrollment_intents owned WHERE owned.contact_id=c.id
          AND owned.preparation_state IN ('pending_validation','ready_held')))
      ORDER BY c.id LIMIT 250`));
    // Validation completion lane. A finished provider answer is stored against the address, but the
    // pending recipient only advances when preparation revisits its contact. Waiting for the keyset
    // cursors to wrap left answered recipients pending for days, so contacts whose pending
    // preparation already has a definite stored answer are revisited first, a bounded slice per tick.
    // The slice rotates every 30 minutes so a recipient that cannot advance never starves the others.
    const completionPage=async()=>rows(await db.execute(sql`SELECT answered.id,TRUE AS has_preparation FROM (
        SELECT DISTINCT i.contact_id AS id FROM cr04_enrollment_intents i
        JOIN provider_observations po ON po.provider='zerobounce' AND po.email_token_hash=i.normalized_email_hash
          AND po.retryable=FALSE AND po.outcome IN ('valid','invalid')
        WHERE i.program_id IS NOT NULL AND i.preparation_state='pending_validation') answered
      ORDER BY md5(answered.id::text||floor(extract(epoch FROM now())/1800)::text)
      LIMIT 150`));
    const completionContacts=await completionPage();
    active=timingsByLane.completion;
    const completion=completionContacts.length
      ? await processPage(completionContacts,
          {afterContactId:0,cycles:0,scanned:0,prepared:0,held:0,reasons:{},lastCycleAt:null},
          laneDeadline("completion",30_000))
      : {examined:0,prepared:0};
    // Stale-package refresh lane. Republishing a package makes every recipient prepared against the previous
    // content stale (not releasable until re-prepared). The keyset cursors only reach those contacts as they wrap,
    // which took many hours per republish, so contacts whose live preparation pins a superseded package are revisited
    // first, a bounded slice per tick. Re-preparation updates the existing intent in place (same membership,
    // receipts and ownership) and touches neither cursor. The slice rotates every 30 minutes so a recipient that
    // cannot become current never starves the others.
    const stalePackagePage=async()=>rows(await db.execute(sql`SELECT stale.id,TRUE AS has_preparation FROM (
        SELECT DISTINCT i.contact_id AS id FROM cr04_enrollment_intents i
        WHERE i.program_id IS NOT NULL AND i.preparation_state IN ('pending_validation','ready_held')
          AND EXISTS (SELECT 1 FROM sfp_campaign_package_versions cur
            WHERE cur.sequence_id=i.sequence_id AND cur.lifecycle_state='current')
          AND NOT EXISTS (SELECT 1 FROM sfp_campaign_package_versions pkg
            WHERE pkg.sequence_id=i.sequence_id AND pkg.lifecycle_state='current'
              AND pkg.id::text=i.preparation_snapshot->>'packageVersionId'
              AND pkg.content_hash=i.preparation_snapshot->>'contentHash')) stale
      ORDER BY md5(stale.id::text||floor(extract(epoch FROM now())/1800)::text)
      LIMIT 150`));
    const staleContacts=await stalePackagePage();
    active=timingsByLane.stale;
    const stalePackage=staleContacts.length
      ? await processPage(staleContacts,
          {afterContactId:0,cycles:0,scanned:0,prepared:0,held:0,reasons:{},lastCycleAt:null},
          laneDeadline("stale",staleBudgetMs))
      : {examined:0,prepared:0};
    const contacts=await populationPage();
    active=timingsByLane.population;
    // Population keeps its reserved window and stops where the priority reserve begins, so neither fair-share
    // lane can be consumed by the completion/stale lanes or by the other.
    const population=await processPage(contacts,state,laneDeadline("population",45_000));
    let populationPages=1;
    let populationComplete=false;
    if (population.examined===contacts.length && contacts.length<250) {
      state.afterContactId=0;state.cycles++;state.lastCycleAt=new Date().toISOString();
      populationComplete=true;
    }
    let priority={examined:0,prepared:0};
    // Candidate retrieval only: this does not admit all stored addresses. A separate keyset revisits
    // current bindings without waiting days for the population cursor to reach newly linked, high-ID
    // recipients. The lane keeps taking pages while time remains (bounded) instead of stopping after one
    // 25-row page; a full priority cycle is then limited by preparation work, not by one fixed page per tick.
    const PRIORITY_PAGE=25;
    // The lane exists to reach recipients that have NO live preparation yet (newly linked, high-ID uploads). Contacts
    // that already hold a pending_validation/ready_held intent are not candidates here: re-qualifying each of them cost
    // 2-5 seconds per cycle and consumed the lane's whole window on work that the completion, stale-package and population
    // lanes already own (answered validations, superseded packages, retirement of changed facts).
    const priorityPage=async()=>rows(await db.execute(sql`SELECT c.id,FALSE AS has_preparation
        FROM contacts c ${bindingJoins}
        WHERE c.id>${priorityCursor.afterContactId} AND c.record_class='production'
          AND c.archived_at IS NULL AND c.do_not_contact IS NOT TRUE
          AND b.record_class='canonical' AND c.email IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM cr04_enrollment_intents owned WHERE owned.contact_id=c.id
            AND owned.preparation_state IN ('pending_validation','ready_held'))
          AND EXISTS(SELECT 1 FROM contact_business_link_decisions independent
            WHERE independent.contact_id=c.id AND independent.business_id=b.id
              AND independent.decision='verified' AND independent.superseded_at IS NULL)
        GROUP BY c.id
        ORDER BY c.id LIMIT ${PRIORITY_PAGE}`));
    let priorityPages=0;
    // The priority lane takes at most this share of the tick, so population coverage keeps moving.
    const priorityDeadline=laneDeadline("priority",Math.max(50_000,priorityReserveMs));
    // The upload cohort goes first inside that window (about two thirds of it); the ID-ordered lane keeps the rest.
    const cohort=await runCohortLane(Date.now()+Math.floor((priorityDeadline-Date.now())*0.65));
    while (Date.now()<priorityDeadline && priorityPages<MAX_PRIORITY_PAGES_PER_TICK) {
      const selected=await priorityPage();
      active=timingsByLane.priority;
      const result=await processPage(selected,priorityCursor,priorityDeadline);
      priorityPages++;
      priority={examined:priority.examined+result.examined,prepared:priority.prepared+result.prepared};
      if (result.examined===selected.length && selected.length<PRIORITY_PAGE) {
        priorityCursor.afterContactId=0;priorityCursor.cycles++;
        priorityCursor.lastCycleAt=new Date().toISOString();
        break;
      }
      if (result.examined!==selected.length) break; // deadline reached inside the page
    }
    // Spend the remaining local budget on more keyset pages, not a ten-minute
    // idle wait after every 250 unbound records. Priority always runs before
    // these extra pages; all pages share the same lease and write guards.
    if (!populationComplete && population.examined===contacts.length) {
      while (populationPages<maxPopulationPages && Date.now()<deadline) {
        const next=await populationPage();
        active=timingsByLane.population;
        const result=await processPage(next,state);
        populationPages++;
        population.examined+=result.examined;population.prepared+=result.prepared;
        if (result.examined!==next.length) break;
        if (next.length<250) {
          state.afterContactId=0;state.cycles++;state.lastCycleAt=new Date().toISOString();
          break;
        }
      }
    }
    return {ran:true,...population,populationPages,cycles:state.cycles,priority:{...priority,pages:priorityPages},uploadCohort:cohort,completion,stalePackage,
      timingsMs:Object.fromEntries(Object.entries(timingsByLane).filter(([,v])=>Object.keys(v).length>0))};
  } catch (error) {
    failed=true;
    throw error;
  } finally {
    // Neither expiry nor an owner transfer can persist stale cursor progress.
    // Preserve the original error when a failed pass also cannot release.
    try {await checkpoint(true);} catch(error) {if (!failed) throw error;}
  }
}