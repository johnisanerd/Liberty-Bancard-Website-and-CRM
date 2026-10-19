import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { effectiveBusinessVerticalSql } from "@shared/effective-vertical";
import { contactTargetVerticalSql } from "@shared/contact-vertical-taxonomy";
import { assertCanonicalPreparationDatabaseGuard,prepareCanonicalRecipient } from "./canonical-recipient-preparation";
import { claimSfpRuntimeDeploymentOwner,lockCurrentSfpRuntimeOwner } from "./cro03/sfp-provider-operations";
import { runCanonicalTransaction,boundCanonicalWriteTransaction } from "./canonical-transaction-retry";
import {assertCanonicalPreparationLease,checkpointCanonicalPreparationLease} from "./canonical-preparation-lease";

const KEY="canonical_recipient_preparation_cursor";
/** Priority-lane 25-row pages per tick (a single page per tick took 2+ days per full cycle). */
const MAX_PRIORITY_PAGES_PER_TICK=4;
const rows=(result:any):any[]=>result?.rows ?? result ?? [];
type Cursor={afterContactId:number;cycles:number;scanned:number;prepared:number;held:number;
  reasons:Record<string,number>;leaseToken:string|null;leaseUntil:string|null;lastCycleAt:string|null;
  priority?:{afterContactId:number;cycles:number;scanned:number;prepared:number;held:number;
    reasons:Record<string,number>;lastCycleAt:string|null}};

/** Local selection only. Uses the existing published owner, enrollment ledger
 * and queue tick. Provider pauses never gate this pass; it cannot send or spend. */
export async function processCanonicalRecipientPreparationTick(
  budget:{maxPopulationPages?:number}={},
) {
  const maxPopulationPages=budget.maxPopulationPages ?? 20;
  if (!Number.isInteger(maxPopulationPages) || maxPopulationPages<1 || maxPopulationPages>20) {
    throw new Error("CANONICAL_PREPARATION_INVALID_TICK_BUDGET");
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
  const deadline=Date.now()+90_000;
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
  const processPage=async(contacts:any[],progress:NonNullable<Cursor["priority"]>,pageDeadline=deadline)=>{
    let examined=0,prepared=0;
    // This is candidate retrieval, never write authority. Unbound contacts need
    // no per-row owner-locked transaction; genuine prepared slots still retire
    // under the existing guard, and every actual preparation rechecks its
    // binding and native/runtime authority before writing.
    const bindings=contacts.length ? rows(await db.execute(sql`
      SELECT DISTINCT c.id AS contact_id,p.id AS program_id,seq.id AS sequence_id
      FROM contacts c ${bindingJoins}
      WHERE c.id IN (${sql.join(contacts.map(contact=>sql`${Number(contact.id)}`),sql`,`)})
        AND c.archived_at IS NULL AND c.do_not_contact IS NOT TRUE
        AND b.record_class='canonical' AND c.email IS NOT NULL
      ORDER BY c.id,p.id,seq.id
    `)) : [];
    const bindingsByContact=new Map<number,Map<string,number[]>>();
    for (const binding of bindings) {
      const contactId=Number(binding.contact_id),programId=String(binding.program_id);
      const programs=bindingsByContact.get(contactId) ?? new Map<string,number[]>();
      programs.set(programId,[...(programs.get(programId) ?? []),Number(binding.sequence_id)]);
      bindingsByContact.set(contactId,programs);
    }
    for (const contact of contacts) {
      if (Date.now()>=pageDeadline) break;
      // Unbound population rows do not regain a per-row authority transaction.
      // Renew between bounded pages/time slices; actual effects checkpoint
      // independently before/after qualification and after their commits.
      if (Date.now()-lastCheckpointAt>=30_000) await checkpoint();
      // Include unavailable/changed recipients: stale paused slots must retire,
      // so suppressions and affiliation changes cannot strand the allowance.
      if (contact.has_preparation===true) await runCanonicalTransaction("preparation_retirement",()=>db.transaction(async tx=>{
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
      }));
      const programs=bindingsByContact.get(Number(contact.id)) ?? new Map<string,number[]>();
      let advanced=false,reason="NO_CURRENT_PROGRAM_BINDING_OR_AVAILABLE_EMAIL";
      for (const [programId,sequences] of programs) {
        if (Date.now()>=pageDeadline) break;
        if (sequences.length!==1) {reason="PROGRAM_BINDING_AMBIGUOUS";continue;}
        try {
          const result=await prepareCanonicalRecipient({
            contactId:Number(contact.id),programId,sequenceId:sequences[0],
            actor:{role:"admin",actorId,email:null},source:"canonical_automatic_selection",beforeWrite:guard,
            checkpoint,
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
      if (advanced) progress.prepared++;
      else {progress.held++;progress.reasons[reason]=(progress.reasons[reason] ?? 0)+1;}
      if (advanced || contact.has_preparation===true || Date.now()-lastCheckpointAt>=30_000) await checkpoint();
    }
    await checkpoint();
    return {examined,prepared};
  };
  let failed=false;
  try {
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
    const completion=completionContacts.length
      ? await processPage(completionContacts,
          {afterContactId:0,cycles:0,scanned:0,prepared:0,held:0,reasons:{},lastCycleAt:null},
          Math.min(deadline,Date.now()+30_000))
      : {examined:0,prepared:0};
    const contacts=await populationPage();
    // Keep the population pass first so priority work cannot starve coverage.
    const population=await processPage(contacts,state,Math.min(deadline,Date.now()+45_000));
    let populationPages=1;
    let populationComplete=false;
    if (population.examined===contacts.length && contacts.length<250) {
      state.afterContactId=0;state.cycles++;state.lastCycleAt=new Date().toISOString();
      populationComplete=true;
    }
    let priority={examined:0,prepared:0};
    // Candidate retrieval only: this does not admit all stored addresses. A separate keyset revisits
    // current bindings without waiting days for the population cursor to reach newly linked, high-ID
    // recipients. Held or unchanged candidates cost little, so the lane keeps taking pages while
    // time remains (bounded) instead of stopping after one 25-row page; a full priority cycle is then
    // limited by preparation work, not by one fixed page per tick.
    const PRIORITY_PAGE=25;
    const priorityPage=async()=>rows(await db.execute(sql`WITH priority_candidates AS (
        SELECT c.id FROM contacts c WHERE c.id>${priorityCursor.afterContactId}
          AND EXISTS(SELECT 1 FROM cr04_enrollment_intents owned WHERE owned.contact_id=c.id
            AND owned.preparation_state IN ('pending_validation','ready_held'))
        UNION
        SELECT c.id FROM contacts c ${bindingJoins}
        WHERE c.id>${priorityCursor.afterContactId} AND c.record_class='production'
          AND c.archived_at IS NULL AND c.do_not_contact IS NOT TRUE
          AND b.record_class='canonical' AND c.email IS NOT NULL
          AND EXISTS(SELECT 1 FROM contact_business_link_decisions independent
            WHERE independent.contact_id=c.id AND independent.business_id=b.id
              AND independent.decision='verified' AND independent.superseded_at IS NULL)
      ) SELECT c.id,EXISTS (
          SELECT 1 FROM cr04_enrollment_intents owned WHERE owned.contact_id=c.id
            AND owned.preparation_state IN ('pending_validation','ready_held')) AS has_preparation
        FROM priority_candidates c
        ORDER BY c.id LIMIT ${PRIORITY_PAGE}`));
    let priorityPages=0;
    // The priority lane takes at most this share of the tick, so population coverage keeps moving.
    const priorityDeadline=Math.min(deadline,Date.now()+50_000);
    while (Date.now()<priorityDeadline && priorityPages<MAX_PRIORITY_PAGES_PER_TICK) {
      const selected=await priorityPage();
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
    return {ran:true,...population,populationPages,cycles:state.cycles,priority:{...priority,pages:priorityPages},completion};
  } catch (error) {
    failed=true;
    throw error;
  } finally {
    // Neither expiry nor an owner transfer can persist stale cursor progress.
    // Preserve the original error when a failed pass also cannot release.
    try {await checkpoint(true);} catch(error) {if (!failed) throw error;}
  }
}