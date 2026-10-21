/**
 * Narrow assignment policy for independently established businesses.
 *
 * A contact is assigned to a business only when ALL of these agree, evaluated per contact:
 *  - the contact's corporate domain (email domain and/or website; populated values must not contradict)
 *    equals the business's own website domain, which is not a shared mailbox/social/listing domain;
 *  - the company identity matches (normalized legal-suffix-free name equality);
 *  - affirmative location evidence agrees (contact city AND state equal the business's city AND state);
 *  - the business is independently established (canonical, discovered by registry/provider, not derived
 *    from a contact or CRM row);
 *  - no competing identity: exactly one canonical business on the domain, the domain is not shared by
 *    several company identities among contacts (shared-brand ambiguity), and no other canonical business
 *    carries the same identity at the same location;
 *  - no existing contradictory assignment: the contact has no current decision, and no other contact with
 *    the same domain and company identity is already assigned to a different business.
 * Vertical, email validation status and deliverability never gate or veto assignment. Assignment is not
 * send permission: contactability is decided later by the existing authorities.
 *
 * The write goes through decideContactBusinessLink (the existing audited relationship writer), requires an
 * administrator, records a software-produced evidence event, and re-evaluates the contact inside the
 * writer's transaction. There is no bulk approval of a stored snapshot.
 */
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { decideContactBusinessLink } from "./commercial-link-authority";

export const DOMAIN_LOCATION_RULE = "independent_domain_company_location_v1";
const rows = (result: any): any[] => result.rows ?? result;
const digest = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

const SHARED = [
  "gmail.com","googlemail.com","yahoo.com","yahoo.co.uk","outlook.com","hotmail.com","live.com","aol.com",
  "icloud.com","me.com","msn.com","proton.me","protonmail.com","mail.com","comcast.net","att.net",
  "bellsouth.net","sbcglobal.net","verizon.net","cox.net","facebook.com","instagram.com","linkedin.com",
  "twitter.com","x.com","yelp.com","business.site","sites.google.com","google.com","linktr.ee","tiktok.com",
  "bit.ly","waze.com",
];
const rawName = (expr: string) => sql.raw(`btrim(regexp_replace(regexp_replace(
  regexp_replace(lower(coalesce(${expr},'')),'[^a-z0-9]+',' ','g'),
  '\\m(inc|incorporated|llc|llp|ltd|limited|corp|corporation|company|co)\\M',' ','g'),
  '[[:space:]]+',' ','g'))`);
const emailDomain = (expr: string) => sql.raw(`(CASE WHEN position('.' in split_part(${expr},'@',2))>0
  AND lower(btrim(split_part(${expr},'@',2))) <> ALL(ARRAY[${SHARED.map(d => `'${d}'`).join(",")}]::text[])
  THEN lower(btrim(split_part(${expr},'@',2))) END)`);
const websiteDomain = (expr: string) => {
  const host = `NULLIF(lower(regexp_replace(split_part(split_part(regexp_replace(btrim(coalesce(${expr},'')),'^[a-zA-Z]+://',''),'/',1),':',1),'^www[.]','','i')),'')`;
  const list = `ARRAY[${SHARED.map(d => `'${d}'`).join(",")}]::text[]`;
  return sql.raw(`(CASE WHEN position('.' in coalesce(${host},''))>0 AND ${host} <> ALL(${list})
    AND NOT EXISTS (SELECT 1 FROM unnest(${list}) s WHERE ${host} LIKE '%.'||s) THEN ${host} END)`);
};
const stateNorm = (expr: string) => sql.raw(`(CASE WHEN upper(btrim(coalesce(${expr},'')))='FLORIDA' THEN 'FL' ELSE NULLIF(upper(btrim(coalesce(${expr},''))),'') END)`);
const cityNorm = (expr: string) => sql.raw(`NULLIF(lower(btrim(coalesce(${expr},''))),'')`);
const bizDomain = sql.raw(`NULLIF(lower(regexp_replace(btrim(coalesce(b.website_domain,'')),'^www[.]','','i')),'')`);

export interface DomainLocationRow {
  contactId: number;
  businessId: number;
  companyName: string | null;
  businessName: string;
  domain: string;
  contactCity: string | null;
  contactState: string | null;
  businessCity: string | null;
  businessState: string | null;
  businessPostalCode: string | null;
  emailStatus: string | null;
  businessLastSourceType: string | null;
  reasons: string[];
  eligible: boolean;
  snapshotHash: string;
}

/** The set-based evaluation query. `filter` selects contacts (aliased c). Reads only; no provider calls. */
export function domainLocationPolicyQuery(filter: any) {
  return sql`
    WITH cc AS MATERIALIZED (
      SELECT c.id,c.company_name,c.city,c.state,c.email_status,
             ${rawName("c.company_name")} cname,
             ${emailDomain("c.email")} edom, ${websiteDomain("c.website")} wdom
        FROM contacts c
       WHERE ${filter}
         AND c.archived_at IS NULL AND c.business_id IS NULL
         AND COALESCE(c.record_class,'unknown') NOT IN ('test','demo','synthetic')
         AND NULLIF(btrim(c.company_name),'') IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM contact_business_link_decisions d WHERE d.contact_id=c.id AND d.superseded_at IS NULL)
    ), cd AS MATERIALIZED (
      SELECT cc.*,(edom IS NOT NULL AND wdom IS NOT NULL AND edom<>wdom) domain_conflict,
             CASE WHEN edom IS NOT NULL AND wdom IS NOT NULL AND edom<>wdom THEN NULL ELSE COALESCE(edom,wdom) END cdom
        FROM cc
    ), bm AS MATERIALIZED (
      SELECT cd.id cid,b.id bid,b.canonical_name,b.city bcity,b.state bstate,b.postal_code,b.last_source_type,
             ${bizDomain} bdom,${rawName("b.canonical_name")} bname,
             (b.last_source_type IN ('serper','sunbiz','google_maps_outscraper')
               OR EXISTS (SELECT 1 FROM canonical_source_links l WHERE l.business_id=b.id AND l.source_system<>'crm')) independent,
             EXISTS (SELECT 1 FROM canonical_source_links l WHERE l.business_id=b.id AND l.source_system='crm') contact_derived
        FROM cd JOIN businesses b ON b.record_class='canonical' AND ${bizDomain}=cd.cdom
       WHERE cd.cdom IS NOT NULL
    ), ad AS MATERIALIZED (
      SELECT x.id,x.business_id,x.nm,d.dom
        FROM (SELECT c2.id,c2.business_id,${rawName("c2.company_name")} nm,
                     ${emailDomain("c2.email")} edom,${websiteDomain("c2.website")} wdom
                FROM contacts c2
               WHERE c2.archived_at IS NULL AND COALESCE(c2.record_class,'unknown') NOT IN ('test','demo','synthetic')
                 AND NULLIF(btrim(c2.company_name),'') IS NOT NULL) x
        CROSS JOIN LATERAL (VALUES (x.edom),(x.wdom)) d(dom)
       WHERE d.dom IS NOT NULL AND d.dom IN (SELECT bdom FROM bm) AND x.nm<>''
    ), dc AS MATERIALIZED (SELECT dom,count(DISTINCT nm) identities FROM ad GROUP BY dom),
    bn AS MATERIALIZED (
      SELECT ${rawName("o.canonical_name")} nm,${cityNorm("o.city")} ct,${stateNorm("o.state")} st,count(*) n
        FROM businesses o WHERE o.record_class='canonical'
         AND ${rawName("o.canonical_name")} IN (SELECT bname FROM bm)
       GROUP BY 1,2,3
    )
    SELECT cd.id contact_id,bm.bid business_id,cd.company_name,bm.canonical_name business_name,cd.cdom domain,
           cd.city contact_city,cd.state contact_state,bm.bcity business_city,bm.bstate business_state,
           bm.postal_code business_postal_code,cd.email_status,bm.last_source_type,cd.cname,bm.bname,
           count(*) OVER (PARTITION BY cd.id) domain_businesses,
           COALESCE(dc.identities,0) identities,
           COALESCE((SELECT sum(bn.n) FROM bn WHERE bn.nm=bm.bname AND bn.ct IS NOT DISTINCT FROM ${cityNorm("bm.bcity")}
             AND bn.st IS NOT DISTINCT FROM ${stateNorm("bm.bstate")}),0)::int same_identity_here,
           EXISTS (SELECT 1 FROM ad WHERE ad.dom=cd.cdom AND ad.nm=cd.cname AND ad.business_id IS NOT NULL
             AND ad.business_id<>bm.bid AND ad.id<>cd.id) contradictory,
           (${cityNorm("cd.city")} IS NOT NULL AND ${stateNorm("cd.state")} IS NOT NULL
             AND ${cityNorm("cd.city")}=${cityNorm("bm.bcity")} AND ${stateNorm("cd.state")}=${stateNorm("bm.bstate")}) location_ok,
           bm.independent,bm.contact_derived,cd.domain_conflict
      FROM cd JOIN bm ON bm.cid=cd.id LEFT JOIN dc ON dc.dom=cd.cdom
     ORDER BY cd.id,bm.bid
  `;
}

export function interpretDomainLocationRows(result: any[]): DomainLocationRow[] {
  return result.map((r: any) => {
    const reasons = [
      Number(r.domain_businesses) > 1 ? "multiple_businesses_on_domain" : null,
      Number(r.identities) > 1 ? "shared_brand_domain" : null,
      !r.cname || r.cname !== r.bname ? "company_name_mismatch" : null,
      !r.location_ok ? "location_not_affirmed" : null,
      !r.independent ? "business_not_independent" : null,
      r.contact_derived ? "business_contact_derived" : null,
      Number(r.same_identity_here) > 1 ? "competing_identity_same_location" : null,
      r.contradictory ? "contradictory_existing_assignment" : null,
    ].filter(Boolean) as string[];
    const facts = {
      rule: DOMAIN_LOCATION_RULE, contactId: Number(r.contact_id), businessId: Number(r.business_id),
      companyIdentity: r.cname, domain: r.domain,
      location: [String(r.contact_city ?? "").trim().toLowerCase(), String(r.contact_state ?? "").trim().toUpperCase()],
      businessLocation: [String(r.business_city ?? "").trim().toLowerCase(), String(r.business_state ?? "").trim().toUpperCase()],
      domainBusinesses: Number(r.domain_businesses), identities: Number(r.identities),
    };
    return {
      contactId: Number(r.contact_id), businessId: Number(r.business_id), companyName: r.company_name,
      businessName: r.business_name, domain: r.domain, contactCity: r.contact_city, contactState: r.contact_state,
      businessCity: r.business_city, businessState: r.business_state, businessPostalCode: r.business_postal_code,
      emailStatus: r.email_status, businessLastSourceType: r.last_source_type,
      reasons, eligible: reasons.length === 0, snapshotHash: digest(facts),
    } satisfies DomainLocationRow;
  });
}

/** One set-based evaluation. `filter` selects contacts (aliased c). Reads only; no provider calls. */
export async function evaluateDomainLocationPolicy(executor: { execute(q: any): Promise<any> }, filter: any): Promise<DomainLocationRow[]> {
  return interpretDomainLocationRows(rows(await executor.execute(domainLocationPolicyQuery(filter))));
}

export const MAX_CONTACT_ID_SPAN = 50000;

/** Read-only window over contact ids. Returns every contact whose domain matches a canonical business. */
export async function previewDomainLocationAssignments(input: { afterContactId: number; span?: number }) {
  const span = Math.min(MAX_CONTACT_ID_SPAN, Math.max(1, input.span ?? 20000));
  const upper = input.afterContactId + span;
  const items = await evaluateDomainLocationPolicy(db, sql`c.id > ${input.afterContactId} AND c.id <= ${upper}`);
  const maxId = Number(rows(await db.execute(sql`SELECT COALESCE(max(id),0) m FROM contacts`))[0].m);
  const eligible = items.filter(i => i.eligible);
  const byReason: Record<string, number> = {};
  for (const i of items) for (const r of i.reasons) byReason[r] = (byReason[r] ?? 0) + 1;
  return {
    rule: DOMAIN_LOCATION_RULE, writes: 0, paidProviderCalls: 0, afterContactId: input.afterContactId, throughContactId: upper,
    nextCursor: upper < maxId ? upper : null,
    domainMatchedContacts: new Set(items.map(i => i.contactId)).size,
    eligibleContacts: new Set(eligible.map(i => i.contactId)).size,
    eligibleBusinesses: new Set(eligible.map(i => i.businessId)).size,
    ineligibleByReason: byReason,
    eligible,
  };
}

/** Applies one contact. Re-evaluates inside the writer's transaction; the caller supplies the preview hash. */
export async function applyDomainLocationAssignment(
  item: { contactId: number; businessId: number; snapshotHash: string }, reviewerId: string,
) {
  const decisionKey = `${DOMAIN_LOCATION_RULE}:${item.contactId}:${item.businessId}:${item.snapshotHash}`;
  const eventKey = `identity_match:${decisionKey}`;
  const current = async (executor: any) => (await evaluateDomainLocationPolicy(executor, sql`c.id=${item.contactId}`))
    .find(r => r.businessId === item.businessId);
  try {
    const reviewer = rows(await db.execute(sql`SELECT role FROM users WHERE id=${reviewerId}`))[0];
    if (reviewer?.role !== "admin") throw new Error("COMMERCIAL_LINK_REVIEWER_ROLE_INVALID");
    const replay = rows(await db.execute(sql`
      SELECT d.id,d.contact_id,d.business_id,e.metadata FROM contact_business_link_decisions d
        JOIN contact_source_events e ON e.id=d.evidence_source_event_id
       WHERE d.decision_key=${decisionKey} AND d.superseded_at IS NULL`))[0];
    if (replay) {
      if (Number(replay.contact_id) !== item.contactId || Number(replay.business_id) !== item.businessId
          || replay.metadata?.factsHash !== item.snapshotHash) throw new Error("LINK_REPLAY_CONFLICT");
      return { ...item, status: "replayed", decisionId: replay.id };
    }
    const row = await current(db);
    if (!row?.eligible || row.snapshotHash !== item.snapshotHash) throw new Error("MATCH_CHANGED_REFRESH_PREVIEW");
    const metadata = {
      businessId: item.businessId, rule: DOMAIN_LOCATION_RULE, factsHash: item.snapshotHash,
      evidenceKind: "independent_business_domain_company_location_agreement",
      matchingFacts: { domain: row.domain,
        contactLocation: [row.contactCity, row.contactState], businessLocation: [row.businessCity, row.businessState] },
    };
    await db.execute(sql`INSERT INTO contact_source_events
      (contact_id,event_key,source_category,source_type,source_external_id,actor_type,actor_id,metadata)
      VALUES (${item.contactId},${eventKey},'identity_matching',${DOMAIN_LOCATION_RULE},${String(item.businessId)},
        'system','domain-location-policy',${JSON.stringify(metadata)}::jsonb)
      ON CONFLICT (contact_id,event_key) DO NOTHING`);
    const evidence = rows(await db.execute(sql`SELECT id,metadata FROM contact_source_events
      WHERE contact_id=${item.contactId} AND event_key=${eventKey}`))[0];
    if (!evidence || evidence.metadata?.businessId !== item.businessId || evidence.metadata?.factsHash !== item.snapshotHash) {
      throw new Error("MATCH_EVIDENCE_CONFLICT");
    }
    const decision = await decideContactBusinessLink({
      contactId: item.contactId, businessId: item.businessId, decision: "verified", decisionKey, reviewerId,
      evidenceSourceEventId: Number(evidence.id), expectedRevision: 0,
      authorityCheck: async (tx: any) => {
        const fresh = await current(tx);
        return Boolean(fresh?.eligible && fresh.snapshotHash === item.snapshotHash);
      },
    });
    return { ...item, status: "applied", decisionId: decision.id };
  } catch (error: any) {
    return { ...item, status: "rejected", code: String(error?.message ?? "LINK_FAILED").slice(0, 160) };
  }
}
