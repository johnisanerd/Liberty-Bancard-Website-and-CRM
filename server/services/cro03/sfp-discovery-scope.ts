import { southFloridaProgramZips } from "../cro03a/geography";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { effectiveBusinessVerticalSql } from "@shared/effective-vertical";
import { businessHasDbprLineageSql } from "../dbpr";
import { resolveGeographyFromCandidates } from "./sfp-geography-resolver";
import { serperLookupExclusionSql } from "./sfp-serper-lookup-memory";

const rows = (r: any): any[] => r?.rows ?? r ?? [];
type Executor = { execute(query: any): Promise<any> };

/** Deliberately excludes provider-populated fields: a new observation cannot
 * invalidate its own identity evidence. Qualification/identity/location drift
 * still invalidates a selected target before another paid request. */
export const discoveryBusinessPinSql = sql.raw(`md5(jsonb_build_object(
  'id',b.id,'name',b.canonical_name,'class',b.record_class,'status',b.status,
  'city',b.city,'state',b.state,'zip',b.postal_code,'street',b.street_address,
  'vertical',${effectiveBusinessVerticalSql("b")},
  'locations',COALESCE((SELECT jsonb_agg(to_jsonb(bl) ORDER BY bl.id)
    FROM business_locations bl WHERE bl.business_id=b.id),'[]'::jsonb)
)::text)`);
export const discoveryProgramPinSql = sql.raw(`md5(jsonb_build_object(
  'id',p.id,'counties',p.county_fips,'verticals',p.vertical_ids,
  'taxonomy',p.taxonomy_version,'policy',p.policy_version)::text)`);

/** One predicate for both real scopes; never manufacture cohort membership. */
export function sfpStageScopeSql(reservation?:{programId?:string;selectionHash?:string}) {
  return sql`(
    (sr.program_id IS NULL AND cr.cohort_state='frozen'
      AND cr.voided_at IS NULL AND cr.superseded_at IS NULL
      AND m.business_id=i.business_id)
    OR (sr.program_id=p.id AND sr.cohort_run_id IS NULL
      AND sr.selection_snapshot->>'programHash'=${discoveryProgramPinSql}
      AND p.taxonomy_version=2
      AND sr.selection_snapshot->'geography'->i.business_id::text->>'outcome'='resolved'
      AND sr.selection_snapshot->'geography'->i.business_id::text->>'eligible'='true'
      AND sr.selection_snapshot->'geography'->i.business_id::text->>'countyFips'=ANY(p.county_fips)
      AND EXISTS (SELECT 1 FROM businesses b
        WHERE b.id=i.business_id AND b.record_class='canonical'
          AND sr.selection_snapshot->'businessPins'->>b.id::text=${discoveryBusinessPinSql}
          AND NOT ${businessHasDbprLineageSql(sql`b.id`)}
          AND NOT EXISTS (SELECT 1 FROM sfp_identity_quarantines q
            WHERE q.business_id=b.id AND q.cleared_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM sdr_merchants sm
            WHERE sm.business_id=b.id AND sm.existing_customer_flag=TRUE)
          AND lower(COALESCE(b.status,'')) NOT IN
            ('suppressed','inactive','closed','dissolved','revoked','expired','archived')))
  ) AND (${reservation?.programId ?? null}::uuid IS NULL
    OR sr.program_id=${reservation?.programId ?? null}::uuid)
    AND (${reservation?.selectionHash ?? null}::text IS NULL
      OR md5(sr.selection_snapshot::text)=${reservation?.selectionHash ?? null})`;
}

/** Nullable legacy joins cannot participate in FOR SHARE/UPDATE. Explicitly
 * retain their locks for historical runs, including cancellation/void fences. */
export async function lockSfpStageScope(executor: Executor, stageRunId: string) {
  const parent = rows(await executor.execute(sql`
    SELECT cohort_run_id,program_id FROM sfp_stage_runs
      WHERE id=${stageRunId}::uuid FOR SHARE
  `))[0];
  if (!parent) throw new Error("SFP_PROVIDER_STAGE_RUN_MISSING");
  if (parent.cohort_run_id) {
    await executor.execute(sql`SELECT cr.id FROM sfp_cohort_runs cr
      WHERE cr.id=${parent.cohort_run_id}::uuid FOR SHARE`);
    await executor.execute(sql`SELECT m.id FROM sfp_cohort_members m
      WHERE m.cohort_run_id=${parent.cohort_run_id}::uuid FOR SHARE`);
  } else {
    await executor.execute(sql`SELECT p.id FROM sfp_programs p
      WHERE p.id=${parent.program_id}::uuid FOR SHARE`);
    await executor.execute(sql`SELECT b.id FROM businesses b
      WHERE b.id::text IN (SELECT jsonb_object_keys(selection_snapshot->'businessPins')
        FROM sfp_stage_runs WHERE id=${stageRunId}::uuid) FOR SHARE`);
    await executor.execute(sql`SELECT bl.id FROM business_locations bl
      WHERE bl.business_id::text IN (SELECT jsonb_object_keys(selection_snapshot->'businessPins')
        FROM sfp_stage_runs WHERE id=${stageRunId}::uuid) FOR SHARE`);
  }
}

/** Bounded selection is a work batch, not admission or a spending allowance.
 * Full-population current facts supply targets; no frozen cohort is read. */
/**
 * Which businesses a discovery pass may select.
 *  - "target_vertical": the ordinary scope; the business already has an effective target
 *    vertical in the program.
 *  - "unlabeled": the pre-classification scope for evidence discovery; the business has NO
 *    effective vertical and has not been classified non-target. It admits a business to
 *    look for listing evidence only. It never assigns a vertical or campaign eligibility.
 * Geography, DBPR-lineage, status, quarantine and existing-customer fences are identical.
 */
export type DiscoveryScope = "target_vertical" | "unlabeled";

function scopeVerticalPredicate(scope: DiscoveryScope, verticalIds: string[]) {
  const effective = sql.raw(effectiveBusinessVerticalSql("b"));
  if (scope === "unlabeled") {
    return sql`(${effective} IS NULL AND NOT EXISTS (
      SELECT 1 FROM (SELECT ev.outcome FROM sfp_classification_evidence ev
          WHERE ev.business_id=b.id AND ev.taxonomy_version=2 AND ev.classifier_version=3
            AND ev.terminal_state='completed'
          ORDER BY ev.created_at DESC,ev.id DESC LIMIT 1) latest
       WHERE latest.outcome='non_target'))`;
  }
  return sql`(${effective}::text=ANY(ARRAY[${sql.join(verticalIds.map((v:string)=>sql`${v}`),sql`, `)}]::text[]))`;
}

export async function selectProgramDiscoveryTargets(programId: string, max: number, phase: "serper"|"paid"="paid", scope: DiscoveryScope = "target_vertical") {
  const p = rows(await db.execute(sql`SELECT p.*,${discoveryProgramPinSql} program_hash
    FROM sfp_programs p WHERE p.id=${programId}::uuid AND p.is_active AND p.taxonomy_version=2`))[0];
  if (!p) throw new Error("SFP_PAID_BLOCKED:PROGRAM_INACTIVE");
  if(!p.vertical_ids.length || !p.county_fips.length) throw new Error("SFP_PROGRAM_SCOPE_EMPTY");
  const selected:any[]=[];
  const localZips=sql`ARRAY[${sql.join(southFloridaProgramZips().map(zip=>sql`${zip}`),sql`, `)}]`;
  const batchSize=Math.max(1,Math.min(500,max*10));
  // Scan every candidate when necessary, retaining only a bounded batch.
  // Outside-territory rows at the front must never starve later local rows.
  for(let offset=0;selected.length<max;offset+=batchSize) {
  const candidates = rows(await db.execute(sql`
    SELECT b.*,${discoveryBusinessPinSql} business_pin,
      ${sql.raw(effectiveBusinessVerticalSql("b"))} effective_vertical,0 AS roi_score
    FROM businesses b WHERE b.record_class='canonical'
      AND ${scopeVerticalPredicate(scope, p.vertical_ids)}
      AND NOT ${businessHasDbprLineageSql(sql`b.id`)}
      AND lower(COALESCE(b.status,'')) NOT IN
        ('suppressed','inactive','closed','dissolved','revoked','expired','archived')
      AND lower(b.canonical_name) NOT LIKE '%test%'
      AND lower(b.canonical_name) NOT LIKE '%demo%'
      AND lower(b.canonical_name) NOT LIKE '%internal%'
      AND NOT EXISTS(SELECT 1 FROM sfp_identity_quarantines q WHERE q.business_id=b.id AND q.cleared_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM sdr_merchants sm WHERE sm.business_id=b.id AND sm.existing_customer_flag)
      AND (SELECT count(DISTINCT ci.normalized_email_hash) FROM cr04_enrollment_intents ci
        WHERE ci.business_id=b.id AND ci.program_id=${programId}::uuid
          AND ci.preparation_state IN ('pending_validation','ready_held'))<3
      AND (${phase!=="serper"} OR NULLIF(btrim(b.website_domain),'') IS NULL)
      -- Lookup memory is applied here, inside the candidate query, so businesses that must
      -- not be re-bought cannot occupy the bounded batch. Finite, input- and rule-aware.
      AND (${phase!=="serper"} OR NOT ${serperLookupExclusionSql("b")})
      AND NOT EXISTS(SELECT 1 FROM provider_operations o WHERE o.target_fingerprint='business:'||b.id::text
        AND (o.state='running' OR o.billing_state='reserved'
          OR (o.created_at>NOW()-INTERVAL '24 hours' AND o.purpose=ANY(ARRAY[
            ${sql.join((phase==="serper"?["sfp_official_domain_discovery"]:
              ["sfp_business_identity_discovery","sfp_named_decision_maker_discovery"]).map(v=>sql`${v}`),sql`, `)}
          ]::text[]))))
    -- Nearest to a usable local recipient first. The territory resolver below still decides eligibility;
    -- this only stops out-of-territory rows from occupying the bounded batch ahead of local ones,
    -- and (paid phase) puts businesses whose site is already known ahead of ones that need a site search.
    ORDER BY (left(btrim(COALESCE(b.postal_code,'')),5)=ANY(${localZips}::text[])
        OR EXISTS(SELECT 1 FROM business_locations bl WHERE bl.business_id=b.id
          AND left(btrim(COALESCE(bl.postal_code,'')),5)=ANY(${localZips}::text[]))) DESC,
      (${phase!=="serper"} AND NULLIF(btrim(b.website_domain),'') IS NOT NULL) DESC,
      COALESCE((SELECT max(s.created_at) FROM sfp_stage_items i
      JOIN sfp_stage_runs s ON s.id=i.stage_run_id
      WHERE i.business_id=b.id AND s.program_id=${programId}::uuid),TIMESTAMPTZ 'epoch'),b.id
    LIMIT ${batchSize} OFFSET ${offset}
  `));
  if(!candidates.length) break;
  const allLocations=rows(await db.execute(sql`SELECT business_id,id,is_primary,state,postal_code,city,county_fips
    FROM business_locations WHERE business_id=ANY(ARRAY[
      ${sql.join(candidates.map(b=>sql`${b.id}`),sql`, `)}
    ]::integer[]) ORDER BY business_id,id`));
  for (const b of candidates) {
    const locations=allLocations.filter(l=>l.business_id===b.id);
    const geography=resolveGeographyFromCandidates([...locations.map((l:any)=>({
      locationId:l.id,isPrimary:l.is_primary,state:l.state,postalCode:l.postal_code,city:l.city,
      countyFips:l.county_fips,
    })),{locationId:null,isPrimary:false,state:b.state,postalCode:b.postal_code,
      city:b.city,countyFips:null}]);
    if (!geography.countyFips || !p.county_fips.includes(geography.countyFips)
      || !geography.eligible || geography.outcome!=="resolved") continue;
    selected.push({...b,geography,program_hash:p.program_hash});
    if(selected.length>=max) break;
  }
  }
  return {program:p,targets:selected};
}

export async function assertSfpProgramDiscoveryContract(executor:Executor=db) {
  const installed=rows(await executor.execute(sql`SELECT (
    (SELECT count(*)=3 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='sfp_stage_runs' AND is_nullable='YES'
      AND (column_name,data_type) IN (('program_id','uuid'),('cohort_run_id','uuid'),('selection_snapshot','jsonb')))
    AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='sfp_provider_retrieval_tasks' AND column_name='cohort_run_id' AND is_nullable='YES')
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.sfp_stage_runs')
      AND conname='sfp_stage_runs_parent_scope_chk' AND contype='c' AND convalidated)
  ) installed`))[0];
  if(installed?.installed!==true) throw new Error("CANONICAL_DISCOVERY_NATIVE_CONTRACT_REQUIRED");
}

export async function programDiscoverySelection(programId:string,idempotencyKey:string,max:number,phase:"serper"|"paid",scope:DiscoveryScope="target_vertical") {
  await assertSfpProgramDiscoveryContract();
  const prior=rows(await db.execute(sql`SELECT program_id,selection_snapshot FROM sfp_stage_runs
    WHERE stage='paid_waterfall' AND idempotency_key=${idempotencyKey}`))[0];
  if(prior) {
    if(prior.program_id!==programId || !prior.selection_snapshot)
      throw new Error("SFP_IDEMPOTENCY_PAYLOAD_MISMATCH");
    const ids=Object.keys(prior.selection_snapshot.businessPins).map(Number);
    const targets=ids.length?rows(await db.execute(sql`SELECT b.*,0 AS roi_score FROM businesses b
      WHERE b.id=ANY(ARRAY[${sql.join(ids.map(id=>sql`${id}`),sql`, `)}]::integer[]) ORDER BY b.id`)):[];
    return {snapshot:prior.selection_snapshot,targets:targets.map(b=>({...b,
      geography:prior.selection_snapshot.geography[String(b.id)]}))};
  }
  const selection=await selectProgramDiscoveryTargets(programId,max,phase,scope);
  return {targets:selection.targets,snapshot:{
    programHash:selection.program.program_hash,
    businessPins:Object.fromEntries(selection.targets.map(b=>[String(b.id),b.business_pin])),
    geography:Object.fromEntries(selection.targets.map(b=>[String(b.id),b.geography])),
  }};
}