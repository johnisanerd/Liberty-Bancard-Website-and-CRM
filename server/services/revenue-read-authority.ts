import { pool } from "../db";
import { projectResidualObservations } from "./residual-observation-projection";
import {createHash} from "node:crypto";
import { OPEN_SALES_LEAD_STAGES } from "@shared/schema";
import { computeRate, type RateMetric } from "@shared/metric-contract";
import { authorizeCommercialUseBatch } from "./commercial-resolution";
import { contactTargetVerticalSql, resolveContactTargetVertical } from "@shared/contact-vertical-taxonomy";
import { CLASSIFIER_VERSION } from "./cro03/sfp-vertical-classifier";
import { effectiveContactVerticalSql,effectiveContactVerticalStatusSql } from "@shared/effective-vertical";
import { syntheticQaIdentitySql } from "@shared/synthetic-qa-identity";
import { crmFactRevision } from "./crm-fact-freshness";
import { sql, type SQL } from "drizzle-orm";

export type RevenueUser = { role?: string; email?: string | null };
export type RevenueFilters = {
  limit: number; offset: number; search?: string; status?: string; emailHealth?: string;
  assignedTo?: string; archived?: boolean; recordClass?: string; sort?: string;
  churnRisk?: string; noOutreach?: string; blocked?: boolean; vertical?: string; tag?: string;
  contactedToday?: boolean; hasAssignee?: boolean; leadSource?: string; lifecycle?: string;
  stale?: boolean; recentlyUpdated?: boolean; neverContacted?: boolean; notContactedIn30?: boolean;
  noDeal?: boolean; createdThisWeek?: boolean; pipeline?: string;
  includeArchived?: boolean; groupContactId?: number; offerPath?: string;
  noFollowUp?:boolean; unassigned?:boolean; pastGoLive?:boolean;
  isParentAccount?:boolean;
};

const privileged = (user: RevenueUser) => user.role === "admin" || user.role === "manager";

/** Complete, exact residual relationship projection. Reuses the contact/deal
 * population owners and the MID registry, not capped browser list samples.
 * Returns row identities for filtering without introducing a full-MID read. */
export async function readResidualGroupScope(user:RevenueUser,parentId?:number,filter:{search?:string;period?:string}={}) {
  const client=await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const parentValues:unknown[]=[];
    const parentPredicate=contactReadPredicate(user,{limit:100,offset:0,recordClass:"production",isParentAccount:true},parentValues,"c");
    const parents=await client.query(`SELECT c.id,c.company_name AS "companyName",c.first_name AS "firstName",
      c.last_name AS "lastName" FROM contacts c WHERE ${parentPredicate} ORDER BY c.id`,parentValues);
    if(parentId && !parents.rows.some(row=>row.id===parentId))
      throw new Error("RESIDUAL_GROUP_TARGET_UNAVAILABLE");
    let memberIds:number[]=[];
    let residualIds:number[]=[];
    if(parentId) {
      const values:unknown[]=[parentId];
      const contactPredicate=contactReadPredicate(user,{limit:100,offset:0,recordClass:"production"},values,"c");
      const members=await client.query(`SELECT c.id FROM contacts c WHERE
        (c.id=$1 OR c.parent_contact_id=$1) AND ${contactPredicate} ORDER BY c.id`,values.slice(0,values.length));
      memberIds=members.rows.map(row=>row.id);
      const dealPredicate=dealReadPredicate(user,{},values,"d");
      // Member MID registration is authoritative even when an old deal.mid is
      // absent. A deal-linked MID must retain the deal's independent scope.
      const residuals=await client.query(`SELECT DISTINCT r.id FROM merchant_residuals r
        JOIN merchant_mids mm ON mm.mid=r.merchant_mid JOIN contacts c ON c.id=mm.contact_id
        LEFT JOIN deals d ON d.id=mm.deal_id
        WHERE (c.id=$1 OR c.parent_contact_id=$1) AND ${contactPredicate}
          AND (mm.deal_id IS NULL OR (${dealPredicate})) ORDER BY r.id`,values);
      residualIds=residuals.rows.map(row=>row.id);
    }
    const observationValues:unknown[]=parentId?[parentId]:[];
    const observationContactPredicate=contactReadPredicate(user,{limit:100,offset:0,recordClass:"production"},observationValues,"c");
    const observationDealPredicate=dealReadPredicate(user,{},observationValues,"d");
    const capturedDealPredicate=dealReadPredicate(user,{},observationValues,"od");
    const observations=await client.query(`SELECT r.*,mm.id AS registered_mid_id,
      mm.deal_id AS registered_mid_deal_id,c.id AS member_contact_id,
      COALESCE(c.company_name,concat_ws(' ',c.first_name,c.last_name)) AS member_label,
      concat_ws(' ',a.first_name,a.last_name) AS agent_label,
      ri.status AS confirmed_import_status,od.id AS authorized_observation_deal_id,
      od.partner_org_id AS observation_partner_org_id,
      po.id AS partner_org_id,po.name AS partner_org_name,po.slug AS partner_org_slug
      FROM merchant_residuals r JOIN merchant_mids mm ON mm.mid=r.merchant_mid
      JOIN contacts c ON c.id=mm.contact_id LEFT JOIN deals d ON d.id=mm.deal_id
      LEFT JOIN agents a ON a.id=r.agent_id
      LEFT JOIN residual_imports ri ON ri.id=r.import_id
      LEFT JOIN deals od ON od.id=r.deal_id AND (${capturedDealPredicate})
      LEFT JOIN partner_organizations po ON po.id=od.partner_org_id
      WHERE ${parentId?"(c.id=$1 OR c.parent_contact_id=$1) AND ":""} ${observationContactPredicate}
        AND (mm.deal_id IS NULL OR (${observationDealPredicate}))
      ORDER BY r.month DESC,r.id DESC`,observationValues);
    const projection=projectResidualObservations(observations.rows,filter);
    const timestamp=await client.query("SELECT CURRENT_TIMESTAMP::text AS as_of");
    await client.query("COMMIT");
    const snapshotIdentity=createHash("sha256").update(JSON.stringify({
      asOf:timestamp.rows[0].as_of,parentId:parentId??null,filter,observations:projection.rows,payees:projection.payees,partners:projection.partners,
    })).digest("hex");
    return {snapshotIdentity,parents:parents.rows,memberIds,residualIds,parentId:parentId??null,observations:projection.rows,
      observationSummary:projection.summary,observationSeries:projection.series,observationPayees:projection.payees,
      observationPartners:projection.partners,
      completeness:"complete_exact_relationship" as const,source:"contacts/merchant_mids/merchant_residuals",
      asOf:timestamp.rows[0].as_of,scope:privileged(user) ? "all" : "owned_or_unassigned"};
  } catch(error) {await client.query("ROLLBACK");throw error;}
  finally {client.release();}
}
/** Drizzle consumer adapter for the existing parameterized reader predicate.
 * No second scope SQL. Each parameter is rebound, never interpolated as text. */
export function revenuePredicateSql(user:RevenueUser, domain:"contact"|"deal", filters:Partial<RevenueFilters>={}):SQL {
  const values:unknown[]=[];
  const text=domain==="contact"
    ? contactReadPredicate(user,{limit:50,offset:0,...filters},values,"contacts")
    : dealReadPredicate(user,filters,values,"deals");
  const chunks:SQL[]=[];
  let position=0;
  for(const match of text.matchAll(/\$(\d+)/g)) {
    chunks.push(sql.raw(text.slice(position,match.index)));
    chunks.push(sql`${values[Number(match[1])-1]}`);
    position=match.index!+match[0].length;
  }
  chunks.push(sql.raw(text.slice(position)));
  return sql.join(chunks,sql``);
}
const observeRevenueSubjects = async (
  user: RevenueUser,
  subjects: Array<{ subjectType: "contact" | "deal"; subjectId: number }>,
) => {
  await authorizeCommercialUseBatch({
    subjects, effect: "commercial_reporting",
    observationScope: privileged(user) ? "all" : "owned_or_unassigned",
    maxSubjects: Math.max(1, subjects.length),
  }).catch((error) => {
    console.error("[CRO02_REVENUE_OBSERVATION_FAILED]", {
      count: subjects.length,
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
  });
};

/** SQL ownership is deliberately expressed at every canonical read boundary. */
export function contactScope(user: RevenueUser, alias = "c", values: unknown[] = []): string {
  if (privileged(user)) return "TRUE";
  // Unassigned records remain in an agent's work queue; assigned records and
  // records with a deal owned by the agent are visible only to that agent.
  values.push(user.email ?? "");
  const p = `$${values.length}`;
  return `(${alias}.assigned_to IS NULL OR ${alias}.assigned_to = ${p} OR EXISTS (
    SELECT 1 FROM deals ownership_deal WHERE ownership_deal.contact_id = ${alias}.id
      AND ownership_deal.archived_at IS NULL AND ownership_deal.owner = ${p}
  ))`;
}

function addContactFilters(filters: RevenueFilters, values: unknown[], alias = "c"): string[] {
  const where = [`${alias}.archived_at IS ${filters.archived ? "NOT " : ""}NULL`];
  if (filters.search) {
    values.push(`%${filters.search.trim()}%`);
    const p = `$${values.length}`;
    // Retain the existing CSV's digits-only phone search in the shared boundary,
    // so rows, facets and exports describe the same selected population.
    const digits = filters.search.replace(/\D/g, "");
    let phone = "";
    if (digits.length >= 7) {
      values.push(`%${digits}%`);
      phone = ` OR regexp_replace(COALESCE(${alias}.phone,''),'[^0-9]','','g') LIKE $${values.length}`;
    }
    where.push(`(coalesce(${alias}.first_name,'') || ' ' || coalesce(${alias}.last_name,'') ILIKE ${p}
      OR coalesce(${alias}.email,'') ILIKE ${p} OR coalesce(${alias}.company_name,'') ILIKE ${p}${phone})`);
  }
  if (filters.status) { values.push(filters.status); where.push(`${alias}.status = $${values.length}`); }
  if (filters.emailHealth) { values.push(filters.emailHealth); where.push(`${alias}.email_status = $${values.length}`); }
  if (filters.assignedTo) { values.push(filters.assignedTo); where.push(`${alias}.assigned_to = $${values.length}`); }
  if (filters.recordClass) { values.push(filters.recordClass); where.push(`${alias}.record_class = $${values.length}`); }
  if (filters.recordClass === "production") where.push(`NOT ${syntheticQaIdentitySql(alias)}`);
  if (filters.churnRisk === "high") where.push(`${alias}.churn_risk_tier IN ('High', 'Critical')`);
  if (filters.noOutreach === "24h") where.push(`${alias}.created_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours' AND ${alias}.last_contacted_at IS NULL`);
  if (filters.blocked) where.push(`(${alias}.do_not_contact = TRUE OR ${alias}.email_status IN ('bounced','invalid','opted_out','unsafe'))`);
  if (filters.vertical) {
    const target = resolveContactTargetVertical(filters.vertical);
    values.push(target ?? filters.vertical);
    const p = `$${values.length}`;
    where.push(target ? `${effectiveContactVerticalSql(alias)} = ${p}`
      : `${alias}.vertical = ${p}`);
  }
  if (filters.tag) { values.push(filters.tag); where.push(`$${values.length} = ANY(COALESCE(${alias}.tags, ARRAY[]::text[]))`); }
  if (filters.contactedToday) where.push(`${alias}.last_contacted_at >= CURRENT_DATE AND ${alias}.last_contacted_at < CURRENT_DATE + INTERVAL '1 day'`);
  if (filters.hasAssignee) where.push(`${alias}.assigned_to IS NOT NULL`);
  if(filters.isParentAccount)where.push(`${alias}.is_parent_account=TRUE`);
  if (filters.leadSource) { values.push(filters.leadSource); where.push(`${alias}.lead_source = $${values.length}`); }
  if (filters.lifecycle) { values.push(filters.lifecycle); where.push(`${alias}.lifecycle_state = $${values.length}`); }
  if (filters.stale) where.push(`COALESCE(${alias}.last_contacted_at, ${alias}.updated_at, ${alias}.created_at, to_timestamp(0)) < CURRENT_TIMESTAMP - INTERVAL '30 days'`);
  if (filters.recentlyUpdated) where.push(`${alias}.updated_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'`);
  if (filters.neverContacted) where.push(`${alias}.last_contacted_at IS NULL`);
  if (filters.notContactedIn30) where.push(`(${alias}.last_contacted_at IS NULL OR ${alias}.last_contacted_at < CURRENT_TIMESTAMP - INTERVAL '30 days')`);
  if (filters.noDeal) where.push(`NOT EXISTS (SELECT 1 FROM deals no_deal WHERE no_deal.contact_id = ${alias}.id AND no_deal.archived_at IS NULL)`);
  if (filters.createdThisWeek) where.push(`${alias}.created_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'`);
  return where;
}

/** Shared parameterized population boundary for list/facet/scalar readers.
 * Caller-owned parameter arrays let aggregates pin their date windows too.
 */
export function contactReadPredicate(user: RevenueUser, filters: RevenueFilters, values: unknown[], alias = "c"): string {
  return [...addContactFilters(filters, values, alias), contactScope(user, alias, values)].join(" AND ");
}

/** Same production/nonarchived/owned-or-unassigned population as the deal list. */
export function dealReadPredicate(user: RevenueUser, filters: Pick<RevenueFilters, "pipeline"|"includeArchived"|"assignedTo"|"vertical"|"groupContactId"|"offerPath"|"noFollowUp"|"unassigned"|"pastGoLive">, values: unknown[], alias = "d"): string {
  const where = [`${alias}.record_class='production'`];
  if(!filters.includeArchived)where.push(`${alias}.archived_at IS NULL`);
  if (filters.pipeline) {
    values.push(filters.pipeline);
    where.push(`${alias}.pipeline=$${values.length}`);
  }
  if (!privileged(user)) {
    values.push(user.email ?? "");
    where.push(`(LOWER(${alias}.owner)=LOWER($${values.length}) OR ${alias}.owner IS NULL)`);
  }
  if(filters.assignedTo) {
    values.push(filters.assignedTo);
    where.push(`LOWER(${alias}.owner)=LOWER($${values.length})`);
  }
  if(filters.offerPath) {
    values.push(filters.offerPath);
    where.push(`${alias}.offer_path=$${values.length}`);
  }
  if(filters.noFollowUp)where.push(`${alias}.next_follow_up IS NULL`);
  if(filters.unassigned)where.push(`${alias}.owner IS NULL`);
  if(filters.pastGoLive)where.push(`${alias}.expected_go_live_date < CURRENT_TIMESTAMP AND LOWER(COALESCE(${alias}.boarding_status,'')) NOT IN ('live','approved')`);
  if(filters.vertical) {
    values.push(filters.vertical);
    const parameter=`$${values.length}`;
    where.push(`(${alias}.vertical=${parameter} OR EXISTS(
      SELECT 1 FROM contacts vertical_contact WHERE vertical_contact.id=${alias}.contact_id AND vertical_contact.vertical=${parameter}))`);
  }
  if(filters.groupContactId) {
    values.push(filters.groupContactId);
    const parameter=`$${values.length}`;
    // Reuse the contact authority; group membership does not grant access to
    // a foreign contact or widen the deal-owner predicate above.
    const contactPredicate=contactReadPredicate(user,{limit:50,offset:0},values,"group_contact");
    where.push(`EXISTS(SELECT 1 FROM contacts group_contact WHERE group_contact.id=${alias}.contact_id
      AND (group_contact.id=${parameter} OR group_contact.parent_contact_id=${parameter}) AND ${contactPredicate})`);
  }
  return where.join(" AND ");
}

function orderForPeople(sort?: string): string {
  switch (sort) {
    case "name":
    case "alpha": return "last_name ASC NULLS LAST, first_name ASC NULLS LAST, id ASC";
    case "createdAtAsc": return "created_at ASC NULLS LAST, id ASC";
    case "updatedAt": return "updated_at DESC NULLS LAST, id DESC";
    case "leadScore":
    case "score_desc": return "lead_score DESC NULLS LAST, id DESC";
    case "activity_desc": return "last_contacted_at DESC NULLS LAST, id DESC";
    case "activity_asc": return "last_contacted_at ASC NULLS LAST, id ASC";
    default: return "created_at DESC NULLS LAST, id DESC";
  }
}

function camelize(value: unknown): any {
  if (Array.isArray(value)) return value.map(camelize);
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
    camelize(item),
  ]));
}

// ---------------------------------------------------------------------------
// Facet cache — correct key + single-flight deduplication.
//
// Cache key: derived from the FULL normalized filter object + user scope, so
// boolean predicates that appear as hardcoded SQL (stale, neverContacted,
// blocked, noDeal, etc.) cannot collide with each other.
//
// Single-flight: if an identical facet request is already in-flight we attach
// to its Promise rather than launching a second DB query. Only successful
// completed results are stored; in-flight entries are removed on settle.
//
// Size is bounded at 200 completed entries (evict all expired, then oldest
// half if still over limit).  TTL: 30 seconds.
// ---------------------------------------------------------------------------
interface FacetCacheEntry { value: FacetResult; expiresAt: number }
type FacetResult = { total: number; byRecordClass: Record<string, number>; byEmailHealth: Record<string, number>; asOf: string;
  stageDistribution?:Record<string,number> };

const _facetCache  = new Map<string, FacetCacheEntry>();
const _facetFlight = new Map<string, Promise<FacetResult>>();   // in-flight single-flight
const FACET_CACHE_TTL_MS  = 30_000;
const FACET_CACHE_MAX     = 200;

function _facetCacheKey(user: RevenueUser, filters: RevenueFilters, factRevision:string): string {
  // Include every field that influences the WHERE predicate, plus role scope.
  const scope = privileged(user) ? "all" : (user.email ?? "anon");
  const key = {
    factRevision,
    scope,
    search: filters.search ?? null,
    status: filters.status ?? null,
    emailHealth: filters.emailHealth ?? null,
    assignedTo: filters.assignedTo ?? null,
    recordClass: filters.recordClass ?? null,
    archived: filters.archived ?? false,
    churnRisk: filters.churnRisk ?? null,
    noOutreach: filters.noOutreach ?? null,
    blocked: filters.blocked ?? false,
    vertical: filters.vertical ?? null,
    tag: filters.tag ?? null,
    contactedToday: filters.contactedToday ?? false,
    hasAssignee: filters.hasAssignee ?? false,
    isParentAccount:filters.isParentAccount??false,
    leadSource: filters.leadSource ?? null,
    lifecycle: filters.lifecycle ?? null,
    stale: filters.stale ?? false,
    recentlyUpdated: filters.recentlyUpdated ?? false,
    neverContacted: filters.neverContacted ?? false,
    notContactedIn30: filters.notContactedIn30 ?? false,
    noDeal: filters.noDeal ?? false,
    createdThisWeek: filters.createdThisWeek ?? false,
    pipeline: filters.pipeline ?? null,
  };
  return `facets:v2:${JSON.stringify(key)}`;
}

function _getCachedFacet(key: string): FacetResult | null {
  const entry = _facetCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _facetCache.delete(key); return null; }
  return entry.value;
}

function _setCachedFacet(key: string, value: FacetResult): void {
  if (_facetCache.size >= FACET_CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of _facetCache) { if (now > v.expiresAt) _facetCache.delete(k); }
    if (_facetCache.size >= FACET_CACHE_MAX) {
      // Evict oldest half by insertion order.
      const deleteCount = Math.ceil(_facetCache.size / 2);
      let n = 0;
      for (const k of _facetCache.keys()) { _facetCache.delete(k); if (++n >= deleteCount) break; }
    }
  }
  _facetCache.set(key, { value, expiresAt: Date.now() + FACET_CACHE_TTL_MS });
}

/**
 * Rows-first contact list reader.
 *
 * Returns the paginated contact rows immediately WITHOUT waiting for
 * totals or facets.  Facets are available via readPeopleFacets() which
 * has its own cache + single-flight deduplication so a cold stampede of
 * 20 concurrent requests executes exactly one DB query.
 *
 * The data query uses SELECT c.* with ORDER BY + LIMIT/OFFSET applied
 * directly (no MATERIALIZED CTE, no window function over the full result
 * set).  observeRevenueSubjects() fires after the connection is released.
 */
export async function readPeople(user: RevenueUser, filters: RevenueFilters) {
  const values: unknown[] = [];
  const predicate = contactReadPredicate(user, filters, values);
  const order = orderForPeople(filters.sort);

  const limitIdx  = values.length + 1;
  const offsetIdx = values.length + 2;
  const dataValues = [...values, filters.limit, filters.offset];

  // Fast index scan — connection auto-released after this single query.
  const dataResult = await pool.query(
    `SELECT c.*,c.vertical AS raw_vertical,${effectiveContactVerticalSql("c")} AS vertical,
      ${effectiveContactVerticalSql("c")} AS effective_vertical_id,
      ${effectiveContactVerticalStatusSql("c")} AS effective_vertical_status FROM contacts c WHERE ${predicate}
     ORDER BY ${order}
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    dataValues,
  );
  const data = dataResult.rows.map(camelize);

  // CRO02 observation is handled by the scheduled BullMQ CRO02_OBSERVATION job (every 2h).
  // Do NOT call observeRevenueSubjects here — it issues one getCurrentClass query per contact,
  // saturating the pool on every contacts page load.

  return {
    data,
    limit:   filters.limit,
    offset:  filters.offset,
    filters: { ...filters, recordClass: filters.recordClass ?? "all" },
    scope:   privileged(user) ? "all" : "owned_or_unassigned",
  };
}

/**
 * Facet/count reader — runs separately from the rows query.
 *
 * Guarantees:
 *  • Cache key covers EVERY filter boolean so different predicates cannot
 *    share a cached result.
 *  • Single-flight: concurrent cold requests for the same key attach to
 *    the same in-flight Promise; exactly one DB query runs.
 *  • Only successfully completed results are cached.
 *  • Cache is bounded (FACET_CACHE_MAX entries, 30-second TTL).
 *  • A DB failure rejects the caller's promise cleanly; it is never
 *    reported as an authoritative zero.
 */
export async function readPeopleFacets(user: RevenueUser, filters: RevenueFilters): Promise<FacetResult> {
  const cacheKey = _facetCacheKey(user, filters, await crmFactRevision());

  // 1. Warm cache hit — no DB call.
  const cached = _getCachedFacet(cacheKey);
  if (cached) return cached;

  // 2. In-flight single-flight — attach to an existing Promise.
  const existing = _facetFlight.get(cacheKey);
  if (existing) return existing;

  // 3. Cold — build predicate, launch exactly one DB query.
  const values: unknown[] = [];
  const predicate = contactReadPredicate(user, filters, values);

  const promise: Promise<FacetResult> = pool.query(
    `SELECT
       COALESCE(jsonb_object_agg(record_class, cnt) FILTER (WHERE grouping_id = 1), '{}'::jsonb) AS by_record_class,
       COALESCE(jsonb_object_agg(email_status,  cnt) FILTER (WHERE grouping_id = 2), '{}'::jsonb) AS by_email_health,
       COALESCE(SUM(cnt) FILTER (WHERE grouping_id = 3), 0)::int AS total,
       CURRENT_TIMESTAMP AS as_of
     FROM (
       SELECT record_class, email_status, COUNT(*) AS cnt,
              GROUPING(record_class, email_status) AS grouping_id
       FROM contacts c WHERE ${predicate}
       GROUP BY GROUPING SETS ((record_class),(email_status),())
     ) sub`,
    values,
  ).then((result) => {
    const row = result.rows[0] ?? {};
    const facetResult: FacetResult = {
      total:         Number(row.total  ?? 0),
      byRecordClass: (row.by_record_class  as Record<string, number>) ?? {},
      byEmailHealth: (row.by_email_health  as Record<string, number>) ?? {},
      asOf:          row.as_of ? new Date(row.as_of as string | Date).toISOString() : new Date().toISOString(),
    };
    _setCachedFacet(cacheKey, facetResult);
    return facetResult;
  }).finally(() => {
    _facetFlight.delete(cacheKey);
  });

  _facetFlight.set(cacheKey, promise);
  return promise;
}

/**
 * Revenue Leads reader (contacts with an open sales deal).
 *
 * Single connection, READ ONLY REPEATABLE READ. Data query uses a LATERAL join
 * with ORDER BY + LIMIT applied directly (no MATERIALIZED CTE). Count query
 * runs the same predicate without fetching full row data.
 */
export async function readRevenueLeads(user: RevenueUser, filters: RevenueFilters) {
  const values: unknown[] = [OPEN_SALES_LEAD_STAGES];
  const stages = `$1::text[]`;
  const where = addContactFilters({ ...filters, archived: false, recordClass: "production" }, values);
  where.push(contactScope(user, "c", values));
  where.push(`EXISTS (SELECT 1 FROM deals qualifying_deal WHERE qualifying_deal.contact_id = c.id
    AND qualifying_deal.archived_at IS NULL AND qualifying_deal.record_class = 'production'
    AND qualifying_deal.pipeline = 'sales' AND qualifying_deal.stage = ANY(${stages}))`);
  const predicate = where.join(" AND ");

  // Count query uses parameters $1..$k.
  const countValues = [...values];
  // Data query appends LIMIT and OFFSET as $(k+1) and $(k+2).
  const limitIdx = values.length + 1;
  const offsetIdx = values.length + 2;
  const dataValues = [...values, filters.limit, filters.offset];

  // 1. Paginated data — connection auto-released after query.
  const dataResult = await pool.query(
    `SELECT to_jsonb(c) || jsonb_build_object('primaryDeal', to_jsonb(primary_deal)) AS item
     FROM contacts c
     JOIN LATERAL (
       SELECT d.* FROM deals d
       WHERE d.contact_id = c.id AND d.archived_at IS NULL
         AND d.record_class = 'production' AND d.pipeline = 'sales'
         AND d.stage = ANY(${stages})
       ORDER BY d.updated_at DESC NULLS LAST, d.id DESC LIMIT 1
     ) primary_deal ON TRUE
     WHERE ${predicate}
     ORDER BY primary_deal.updated_at DESC NULLS LAST, primary_deal.id DESC, c.id DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    dataValues,
  );
  const dataRows: { item: unknown }[] = dataResult.rows;

  // 2. Total count — cached 30 s.
  // Key includes scope + all filter fields that affect the predicate.
  // Revenue leads have an additional open-sales-deal predicate. Never reuse
  // the People facet total for this narrower population (or vice versa).
  const cacheKey = `revenue-leads:v1:${JSON.stringify(OPEN_SALES_LEAD_STAGES)}:${_facetCacheKey(user, { ...filters, archived: false, recordClass: "production" }, await crmFactRevision())}`;
  const _cachedLeads = _getCachedFacet(cacheKey);
  let countRow: { total: number; as_of: string | Date } = _cachedLeads
    ? { total: _cachedLeads.total, as_of: _cachedLeads.asOf }
    : { total: 0, as_of: new Date() };
  if (!_cachedLeads) {
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total, CURRENT_TIMESTAMP AS as_of
       FROM contacts c WHERE ${predicate}`,
      countValues,
    );
    const countResultRow = countResult.rows[0] ?? { total: 0, as_of: new Date() };
    countRow = countResultRow;
    _setCachedFacet(cacheKey, {
      total: Number(countResultRow.total ?? 0),
      byRecordClass: {},
      byEmailHealth: {},
      asOf: new Date(countResultRow.as_of as string | Date).toISOString(),
    });
  }

  const data = dataRows.map((row) => camelize(row.item));
  await observeRevenueSubjects(user, data.flatMap((item: any) => [
    { subjectType: "contact" as const, subjectId: Number(item.id) },
    ...(item.primaryDeal?.id ? [{ subjectType: "deal" as const, subjectId: Number(item.primaryDeal.id) }] : []),
  ]));
  return {
    data,
    total: countRow.total ?? 0,
    limit: filters.limit,
    offset: filters.offset,
    filters: { ...filters, archived: false, recordClass: "production", pipeline: "sales" },
    scope: privileged(user) ? "all" : "owned_or_unassigned",
    asOf: new Date(countRow.as_of).toISOString(),
  };
}

/**
 * Canonical production deal list used by Pipeline and other operational readers.
 *
 * Data and cached count are separate reads, not one transaction snapshot.
 * Data query uses ORDER BY + LIMIT directly on the deals table. Counts and
 * stage distribution use the exact same existing-owner predicate.
 */
export async function readRevenueDeals(user: RevenueUser, filters: RevenueFilters) {
  const values: unknown[] = [];
  const value = (input: unknown) => { values.push(input); return `$${values.length}`; };
  const predicate = dealReadPredicate(user, filters, values);

  // Count uses parameters $1..$p; data appends LIMIT=$(p+1), OFFSET=$(p+2).
  const countValues = [...values];
  const limitParam = value(filters.limit ?? 100);
  const offsetParam = value(filters.offset ?? 0);

  // 1. Paginated data — connection auto-released after query.
  const dataReadStartedAt=new Date().toISOString();
  const dataResult = await pool.query(
    `SELECT d.*,
       CONCAT_WS(' ', c.first_name, c.last_name) AS contact_name,
       c.company_name, c.email AS contact_email, c.phone AS contact_phone,
        c.employee_count AS contact_employee_count, c.lead_source AS contact_lead_source,c.vertical AS contact_vertical
     FROM deals d LEFT JOIN contacts c ON c.id = d.contact_id
     WHERE ${predicate}
     ORDER BY d.updated_at DESC NULLS LAST, d.id DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    values,
  );
  const dataRows: Record<string, unknown>[] = dataResult.rows;
  const dataReadCompletedAt=new Date().toISOString();

  // 2. Total count — cached 30 s.
  // Every predicate-changing field participates; offsets do not change totals.
  const dealsCacheScope = privileged(user) ? "all" : (user.email ?? "anon");
  const normalizedFilters={pipeline:filters.pipeline??null,includeArchived:filters.includeArchived??false,
    assignedTo:filters.assignedTo??null,vertical:filters.vertical??null,groupContactId:filters.groupContactId??null,offerPath:filters.offerPath??null,
    noFollowUp:filters.noFollowUp??false,unassigned:filters.unassigned??false,pastGoLive:filters.pastGoLive??false};
  const dealsCacheKey = `deals-count:v3:${JSON.stringify({ factRevision:await crmFactRevision(),scope: dealsCacheScope,...normalizedFilters })}`;
  const _cachedDeals = _getCachedFacet(dealsCacheKey);
  let countRow: { total: number; as_of: string | Date; stage_distribution:Record<string,number> } = _cachedDeals
    ? { total: _cachedDeals.total, as_of: _cachedDeals.asOf,stage_distribution:_cachedDeals.stageDistribution! }
    : { total: 0, as_of: new Date(),stage_distribution:{} };
  if (!_cachedDeals) {
    const countResult = await pool.query(
      `SELECT COALESCE(SUM(stage_count),0)::int AS total,
       COALESCE(jsonb_object_agg(stage,stage_count),'{}'::jsonb) AS stage_distribution, CURRENT_TIMESTAMP AS as_of
       FROM (SELECT d.stage,COUNT(*)::int AS stage_count FROM deals d WHERE ${predicate} GROUP BY d.stage) counted`,
      countValues,
    );
    const countResultRow = countResult.rows[0];
    if(!countResultRow || !countResultRow.stage_distribution)throw new Error("DEAL_COUNT_DTO_UNAVAILABLE");
    countRow = countResultRow;
    _setCachedFacet(dealsCacheKey, {
      total: Number(countResultRow.total ?? 0),
      byRecordClass: {},
      byEmailHealth: {},
      asOf: new Date(countResultRow.as_of as string | Date).toISOString(),
       stageDistribution:countResultRow.stage_distribution,
    });
  }

  const data = dataRows.map(camelize);
  await observeRevenueSubjects(user, data.map((item: any) => ({ subjectType: "deal", subjectId: Number(item.id) })));
  return {
    data,
    total: Number(countRow.total ?? 0),
    stageDistribution:countRow.stage_distribution,
    limit: filters.limit ?? 100,
    offset: filters.offset ?? 0,
    filters: { ...normalizedFilters,archived:filters.includeArchived?"included":false,recordClass: "production" },
    scope: privileged(user) ? "all" : "owned_or_unassigned",
    asOf: new Date(countRow.as_of).toISOString(),
    dataReadWindow:{startedAt:dataReadStartedAt,completedAt:dataReadCompletedAt},
  };
}

export async function readRevenueReconciliation(user: RevenueUser) {
  if (!privileged(user)) throw new Error("REVENUE_RECONCILIATION_FORBIDDEN");
  const result = await pool.query(`
    WITH contact_buckets AS (
      SELECT
      COUNT(*) FILTER (WHERE c.archived_at IS NOT NULL)::int AS archived,
      COUNT(*) FILTER (WHERE c.archived_at IS NULL)::int AS non_archived_contacts,
      COUNT(*) FILTER (WHERE c.archived_at IS NULL AND c.record_class = 'production')::int AS production_contacts,
      COUNT(*) FILTER (WHERE c.archived_at IS NULL AND c.record_class <> 'production')::int AS non_production,
      COALESCE(jsonb_object_agg(c.record_class, class_count) FILTER (WHERE c.record_class <> 'production'), '{}'::jsonb) AS non_production_by_class,
      COUNT(*) FILTER (WHERE c.archived_at IS NULL AND c.record_class='production' AND EXISTS (
        SELECT 1 FROM deals d WHERE d.contact_id=c.id AND d.archived_at IS NULL AND d.record_class='production'
          AND d.pipeline='sales' AND d.stage = ANY($1::text[])))::int AS canonical_lead_contacts,
      COUNT(*) FILTER (WHERE c.archived_at IS NULL AND (
        SELECT COUNT(*) FROM deals d WHERE d.contact_id=c.id AND d.archived_at IS NULL
          AND d.record_class='production' AND d.pipeline='sales' AND d.stage = ANY($1::text[])
      ) > 1)::int AS multiple_qualifying_deals,
      COUNT(*) FILTER (WHERE c.archived_at IS NULL AND EXISTS (
        SELECT 1 FROM deals d WHERE d.contact_id=c.id AND d.archived_at IS NULL AND d.record_class='production'
          AND d.pipeline='sales' AND (d.stage IS NULL OR NOT (d.stage = ANY($1::text[])))))::int AS invalid_unknown_sales_stage,
      COUNT(*) FILTER (WHERE c.archived_at IS NULL AND EXISTS (
        SELECT 1 FROM merchant_mids mm WHERE mm.contact_id=c.id AND mm.status='active' AND mm.activated_at IS NOT NULL))::int AS activated_mid_contacts
      FROM (
        SELECT contacts.*, COUNT(*) OVER (PARTITION BY record_class) AS class_count FROM contacts
      ) c
    ), orphan_buckets AS (
      SELECT
        (SELECT COUNT(*)::int FROM deals d LEFT JOIN contacts c ON c.id=d.contact_id WHERE d.contact_id IS NOT NULL AND c.id IS NULL) AS missing_contact,
        (SELECT COUNT(*)::int FROM merchant_mids mm LEFT JOIN contacts c ON c.id=mm.contact_id
          WHERE mm.status='active' AND mm.activated_at IS NOT NULL
            AND (c.id IS NULL OR c.archived_at IS NOT NULL OR c.record_class <> 'production')) AS active_mid_without_eligible_contact,
        (SELECT COUNT(DISTINCT c.id)::int FROM contacts c
          WHERE c.archived_at IS NULL AND c.record_class='production'
            AND NOT EXISTS (SELECT 1 FROM merchant_mids mm WHERE mm.contact_id=c.id AND mm.status='active' AND mm.activated_at IS NOT NULL)
            AND (c.assigned_to IS NOT NULL OR EXISTS (SELECT 1 FROM deals d WHERE d.contact_id=c.id AND d.archived_at IS NULL))) AS legacy_portfolio_membership
    )
    SELECT contact_buckets.*, orphan_buckets.*, CURRENT_TIMESTAMP AS as_of
    FROM contact_buckets CROSS JOIN orphan_buckets`, [OPEN_SALES_LEAD_STAGES]);
  const { as_of, non_production_by_class, non_archived_contacts, production_contacts, ...buckets } = result.rows[0] ?? {};
  return {
    bucketSemantics: "overlapping",
    warning: "Diagnostic buckets overlap and must not be summed.",
    baseTotals: { nonArchivedContacts: non_archived_contacts ?? 0, productionContacts: production_contacts ?? 0 },
    buckets: camelize({ ...buckets, nonProductionByClass: non_production_by_class ?? {} }),
    filters: { scope: "all" },
    scope: "all",
    asOf: new Date(as_of).toISOString(),
  };
}

export type PipelineAnalytics = {
  sales: {
    total: number;
    /** Open pipeline: stage in OPEN_SALES_LEAD_STAGES, the same definition every other pipeline surface uses. */
    active: number;
    closedWon: number; closedLost: number;
    /** Stage "Nurture / Not Now": neither open pipeline nor a decided outcome. */
    nurture: number;
    /** Sales stage outside the open set, closed outcomes and nurture (legacy or unknown). Not hidden in any other count. */
    unclassifiedStage: number;
    /** Whole percent, or null when no deal has been decided. Read winRateBasis for the exact fraction. */
    winRate: number | null;
    winRateBasis: RateMetric;
    stageDistribution: Record<string, number>; newLast30Days: number; wonLast30Days: number; stallingDeals: number;
  };
  onboarding: { total: number; active: number; completed: number };
};

/**
 * Canonical, uncapped pipeline report. The single statement gives every metric
 * (and its database-sourced as-of value) one PostgreSQL statement snapshot.
 */
export async function readPipelineAnalytics(user: RevenueUser): Promise<{
  data: PipelineAnalytics;
  metadata: { scope: "all" | "owned_or_unassigned"; asOf: string };
}> {
  const values: unknown[] = [];
  const ownership = privileged(user)
    ? "TRUE"
    : (() => {
      values.push(user.email ?? "");
      return `(d.owner IS NULL OR LOWER(d.owner) = LOWER($${values.length}))`;
    })();
  values.push(OPEN_SALES_LEAD_STAGES as unknown as string[]);
  const openParam = `$${values.length}`;
  const result = await pool.query<{
    sales_total: string; sales_active: string; sales_nurture: string; sales_unclassified: string; sales_closed_won: string; sales_closed_lost: string;
    sales_stages: Record<string, number> | null; sales_new_last_30: string; sales_won_last_30: string;
    sales_stalling: string; onboarding_total: string; onboarding_active: string; onboarding_completed: string;
    observed_deal_ids: number[]; as_of: Date;
  }>(`
    WITH scoped_deals AS (
      SELECT d.* FROM deals d
      WHERE d.archived_at IS NULL AND d.record_class = 'production' AND ${ownership}
    ), metrics AS (
      SELECT
        COUNT(*) FILTER (WHERE pipeline = 'sales')::int::text AS sales_total,
        COUNT(*) FILTER (WHERE pipeline = 'sales' AND stage = ANY($OPEN$::text[]))::int::text AS sales_active,
        COUNT(*) FILTER (WHERE pipeline = 'sales' AND stage = 'Nurture / Not Now')::int::text AS sales_nurture,
        COUNT(*) FILTER (WHERE pipeline = 'sales' AND NOT (stage = ANY($OPEN$::text[])) AND stage NOT IN ('Closed Won', 'Closed Lost', 'Nurture / Not Now'))::int::text AS sales_unclassified,
        COUNT(*) FILTER (WHERE pipeline = 'sales' AND stage = 'Closed Won')::int::text AS sales_closed_won,
        COUNT(*) FILTER (WHERE pipeline = 'sales' AND stage = 'Closed Lost')::int::text AS sales_closed_lost,
        COUNT(*) FILTER (WHERE pipeline = 'sales' AND created_at > CURRENT_TIMESTAMP - INTERVAL '30 days')::int::text AS sales_new_last_30,
        COUNT(*) FILTER (WHERE pipeline = 'sales' AND stage = 'Closed Won' AND updated_at > CURRENT_TIMESTAMP - INTERVAL '30 days')::int::text AS sales_won_last_30,
        COUNT(*) FILTER (WHERE pipeline = 'sales' AND stage = ANY($OPEN$::text[]) AND updated_at < CURRENT_TIMESTAMP - INTERVAL '7 days')::int::text AS sales_stalling,
        COUNT(*) FILTER (WHERE pipeline = 'onboarding')::int::text AS onboarding_total,
        COUNT(*) FILTER (WHERE pipeline = 'onboarding' AND stage NOT IN ('Live (First Batch)', 'Active (7 Days)', 'Active (30 Days)', 'Cancelled'))::int::text AS onboarding_active,
        COUNT(*) FILTER (WHERE pipeline = 'onboarding' AND stage IN ('Live (First Batch)', 'Active (7 Days)', 'Active (30 Days)'))::int::text AS onboarding_completed,
        COALESCE((array_agg(id ORDER BY id) FILTER (WHERE id IS NOT NULL))[1:2000], ARRAY[]::integer[]) AS observed_deal_ids,
        CURRENT_TIMESTAMP AS as_of
      FROM scoped_deals
    ), stages AS (
      SELECT COALESCE(jsonb_object_agg(stage, stage_count), '{}'::jsonb) AS sales_stages
      FROM (SELECT stage, COUNT(*)::int AS stage_count FROM scoped_deals WHERE pipeline = 'sales' GROUP BY stage) grouped
    )
    SELECT metrics.*, stages.sales_stages FROM metrics CROSS JOIN stages
  `.replaceAll("$OPEN$", openParam), values);
  const authoritative = result.rows[0];
  if (!authoritative) throw new Error("PIPELINE_ANALYTICS_EMPTY_AGGREGATE");
  const num = (value: string | undefined) => Number.parseInt(value ?? "0", 10);
  const closedWon = num(authoritative.sales_closed_won);
  const closedLost = num(authoritative.sales_closed_lost);
  await observeRevenueSubjects(user, (authoritative.observed_deal_ids ?? [])
    .map((id) => ({ subjectType: "deal", subjectId: Number(id) })));
  return {
    data: {
      sales: {
        total: num(authoritative.sales_total), active: num(authoritative.sales_active), closedWon, closedLost,
        nurture: num(authoritative.sales_nurture), unclassifiedStage: num(authoritative.sales_unclassified),
        winRate: computeRate(closedWon, closedWon + closedLost).percent, winRateBasis: computeRate(closedWon, closedWon + closedLost),
        stageDistribution: authoritative.sales_stages ?? {},
        newLast30Days: num(authoritative.sales_new_last_30), wonLast30Days: num(authoritative.sales_won_last_30),
        stallingDeals: num(authoritative.sales_stalling),
      },
      onboarding: {
        total: num(authoritative.onboarding_total), active: num(authoritative.onboarding_active),
        completed: num(authoritative.onboarding_completed),
      },
    },
    metadata: { scope: privileged(user) ? "all" : "owned_or_unassigned", asOf: new Date(authoritative.as_of).toISOString() },
  };
}
