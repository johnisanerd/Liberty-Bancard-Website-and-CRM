import {sql} from "drizzle-orm";
import {pool} from "../db";
import {MATERIALIZATION_RULE_VERSION} from "./contact-business-materialization-policy";
import {DISPOSITION_RULE_VERSION,type DispositionDraft} from "./contact-link-disposition-policy";

export const CONTACT_BUSINESS_SYSTEM_LINK_RULE_REF = "crm_evidence_identity_v3";
/** Any change to the evidence adapters, materializer or relationship rule changes
 * this string; the worker then re-evaluates earlier dispositions through its
 * ordinary bounded pages, with no manual replay. */
export const PROGRAM_RULE_VERSION =
  `${DISPOSITION_RULE_VERSION}/${MATERIALIZATION_RULE_VERSION}/${CONTACT_BUSINESS_SYSTEM_LINK_RULE_REF}`;

const rows=(result:any):any[]=>result?.rows ?? result ?? [];

/** Upsert current dispositions. Callers run this inside the program's fenced transaction. */
export async function upsertContactLinkDispositions(executor:any,drafts:DispositionDraft[],runId:string) {
  if(!drafts.length)return 0;
  const payload=drafts.map(d=>({contact_id:d.contactId,outcome:d.outcome,reason_code:d.reasonCode,
    rule_version:d.ruleVersion,evidence_fingerprint:d.evidenceFingerprint,evidence_refs:d.evidenceRefs,
    next_retry_trigger:d.nextRetryTrigger,retry_minutes:d.retryDelayMinutes,business_id:d.businessId}));
  await executor.execute(sql`INSERT INTO contact_business_link_dispositions
      (contact_id,outcome,reason_code,rule_version,evidence_fingerprint,evidence_refs,next_retry_trigger,
       next_retry_at,business_id,run_id)
    SELECT x.contact_id,x.outcome,x.reason_code,x.rule_version,x.evidence_fingerprint,x.evidence_refs,
      x.next_retry_trigger,
      CASE WHEN x.retry_minutes IS NULL THEN NULL ELSE clock_timestamp()+make_interval(mins=>x.retry_minutes) END,
      CASE WHEN EXISTS(SELECT 1 FROM businesses b WHERE b.id=x.business_id) THEN x.business_id END,${runId}
    FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS x(contact_id integer,outcome text,reason_code text,
      rule_version text,evidence_fingerprint text,evidence_refs jsonb,next_retry_trigger text,retry_minutes integer,
      business_id integer)
    WHERE EXISTS(SELECT 1 FROM contacts c WHERE c.id=x.contact_id)
    ON CONFLICT (contact_id) DO UPDATE SET outcome=excluded.outcome,reason_code=excluded.reason_code,
      rule_version=excluded.rule_version,evidence_fingerprint=excluded.evidence_fingerprint,
      evidence_refs=excluded.evidence_refs,next_retry_trigger=excluded.next_retry_trigger,
      next_retry_at=excluded.next_retry_at,business_id=excluded.business_id,run_id=excluded.run_id,
      evaluation_count=contact_business_link_dispositions.evaluation_count+1,evaluated_at=clock_timestamp()`);
  return drafts.length;
}

/** Contacts whose automatic retry time has arrived (bounded). */
export async function listDueRetryableContacts(executor:any,limit:number) {
  return rows(await executor.execute(sql`SELECT contact_id FROM contact_business_link_dispositions
    WHERE outcome='retryable' AND next_retry_at<=clock_timestamp()
    ORDER BY next_retry_at,contact_id LIMIT ${limit}`)).map(row=>Number(row.contact_id));
}

/** Capture the dated acceptance population exactly once. Every active non-test
 * contact is recorded with whether it already had a current verified assignment. */
export async function captureAcceptanceBaselineIfMissing(client?:any) {
  const own=!client;
  const db=client ?? await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('contact_link_acceptance_baseline',0))");
    const existing=await db.query("SELECT id FROM contact_link_acceptance_baselines LIMIT 1");
    if(existing.rowCount){await db.query("COMMIT");return {captured:false as const,baselineId:existing.rows[0].id as string};}
    await db.query("SET LOCAL statement_timeout='120s'");
    const created=await db.query(`INSERT INTO contact_link_acceptance_baselines(rule_version,contact_count)
      VALUES($1,0) RETURNING id`,[PROGRAM_RULE_VERSION]);
    const baselineId=created.rows[0].id as string;
    await db.query(`INSERT INTO contact_link_acceptance_members(baseline_id,contact_id,record_class,linked_at_capture)
      SELECT $1::uuid,c.id,c.record_class,
        coalesce(d.decision='verified' AND c.business_id=d.business_id AND b.record_class='canonical',false)
      FROM contacts c
      LEFT JOIN contact_business_link_decisions d ON d.contact_id=c.id AND d.superseded_at IS NULL
      LEFT JOIN businesses b ON b.id=d.business_id
      WHERE c.archived_at IS NULL AND c.record_class IS NOT NULL
        AND c.record_class NOT IN ('test','demo','synthetic')`,[baselineId]);
    const summary=(await db.query(`SELECT count(*)::int total,
      count(*) FILTER(WHERE record_class='production')::int production,
      count(*) FILTER(WHERE record_class<>'production')::int other_non_test,
      count(*) FILTER(WHERE linked_at_capture)::int linked_at_capture
      FROM contact_link_acceptance_members WHERE baseline_id=$1`,[baselineId])).rows[0];
    await db.query(`UPDATE contact_link_acceptance_baselines SET contact_count=$2,population=$3::jsonb WHERE id=$1`,
      [baselineId,summary.total,JSON.stringify(summary)]);
    await db.query("COMMIT");
    return {captured:true as const,baselineId,...summary};
  } catch(error) {
    await db.query("ROLLBACK").catch(()=>undefined);
    throw error;
  } finally { if(own)db.release(); }
}

const OUTCOMES=["linked","unsupported","awaiting_review","retryable"] as const;
function tally(rowsIn:any[]) {
  const out:Record<string,Record<string,number>>={};
  for(const row of rowsIn) {
    (out[row.record_group] ??= {})[row.state]=Number(row.n);
  }
  return out;
}

/** Read-only report. Unavailable reads are reported as unavailable, never zero. */
export async function readContactLinkDispositionReport() {
  try {
    const baseline=(await pool.query(`SELECT id,captured_at,rule_version,contact_count,population
      FROM contact_link_acceptance_baselines ORDER BY captured_at LIMIT 1`)).rows[0];
    if(!baseline)return {state:"baseline_not_captured" as const,programRuleVersion:PROGRAM_RULE_VERSION};
    const accounting=await pool.query(`SELECT CASE WHEN m.record_class='production' THEN 'production' ELSE 'other_non_test' END record_group,
        CASE WHEN d.contact_id IS NULL THEN 'no_disposition'
             WHEN d.rule_version<>$2 THEN 'stale_rule:'||d.outcome ELSE d.outcome END state,count(*)::int n
      FROM contact_link_acceptance_members m
      LEFT JOIN contact_business_link_dispositions d ON d.contact_id=m.contact_id
      WHERE m.baseline_id=$1 GROUP BY 1,2`,[baseline.id,PROGRAM_RULE_VERSION]);
    const intake=await pool.query(`SELECT CASE WHEN c.record_class='production' THEN 'production' ELSE 'other_non_test' END record_group,
        coalesce(d.outcome,'no_disposition') state,count(*)::int n
      FROM contacts c LEFT JOIN contact_business_link_dispositions d ON d.contact_id=c.id
      WHERE c.archived_at IS NULL AND c.record_class IS NOT NULL AND c.record_class NOT IN ('test','demo','synthetic')
        AND NOT EXISTS(SELECT 1 FROM contact_link_acceptance_members m WHERE m.baseline_id=$1 AND m.contact_id=c.id)
      GROUP BY 1,2`,[baseline.id]);
    const reasons=await pool.query(`SELECT d.outcome,d.reason_code,count(*)::int n
      FROM contact_business_link_dispositions d WHERE d.rule_version=$1
      GROUP BY 1,2 ORDER BY n DESC LIMIT 25`,[PROGRAM_RULE_VERSION]);
    const links=(await pool.query(`SELECT count(*)::int verified_links,count(DISTINCT business_id)::int distinct_businesses,
        count(DISTINCT contact_id)::int distinct_contacts,
        count(*) FILTER(WHERE created_at>clock_timestamp()-interval '24 hours')::int committed_last_24h
      FROM contact_business_link_decisions WHERE superseded_at IS NULL AND decision='verified'`)).rows[0];
    const receipts=(await pool.query(`SELECT count(*)::int rows,count(DISTINCT e.contact_id)::int contacts
      FROM import_row_dispositions r JOIN contact_source_events e ON e.import_execution_id=r.execution_id
        AND e.source_row_number=r.source_row_number
      WHERE r.disposition IN ('created','matched_noop')`)).rows[0];
    const retry=(await pool.query(`SELECT count(*) FILTER(WHERE next_retry_at<=clock_timestamp())::int due,
      count(*)::int total FROM contact_business_link_dispositions WHERE outcome='retryable'`)).rows[0];
    return {state:"current" as const,observedAt:new Date().toISOString(),programRuleVersion:PROGRAM_RULE_VERSION,
      baseline:{id:baseline.id,capturedAt:baseline.captured_at,ruleVersion:baseline.rule_version,
        contactCount:Number(baseline.contact_count),population:baseline.population},
      baselineAccounting:tally(accounting.rows),newIntakeSinceBaseline:tally(intake.rows),
      reasonCodes:reasons.rows.map(r=>({outcome:r.outcome,reasonCode:r.reason_code,contacts:Number(r.n)})),
      retryable:{due:Number(retry.due),total:Number(retry.total)},
      separateCounts:{distinctContactsWithVerifiedLink:Number(links.distinct_contacts),
        distinctBusinessesLinked:Number(links.distinct_businesses),verifiedLinks:Number(links.verified_links),
        verifiedLinksCommittedLast24h:Number(links.committed_last_24h),
        originalRowReceiptRows:Number(receipts.rows),originalRowReceiptContacts:Number(receipts.contacts)},
      outcomes:OUTCOMES};
  } catch(error:any) {
    return {state:"unavailable" as const,observedAt:new Date().toISOString(),programRuleVersion:PROGRAM_RULE_VERSION,
      reasonCode:"CONTACT_LINK_DISPOSITION_REPORT_FAILED",detail:String(error?.code ?? error?.message ?? "").slice(0,120)};
  }
}
