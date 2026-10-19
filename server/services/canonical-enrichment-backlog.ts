import { sql } from "drizzle-orm";
import { db } from "../db";
import { effectiveBusinessVerticalSql, effectiveBusinessVerticalStatusSql } from "@shared/effective-vertical";
import { contactTargetVerticalSql } from "@shared/contact-vertical-taxonomy";
import {
  BACKLOG_STAGE_LABELS, BACKLOG_STAGE_ORDER,
  type BacklogCostClass, type BacklogFamily, type BacklogPriorityItem, type BacklogReasonCount,
  type BacklogStageKey, type BacklogState, type CanonicalEnrichmentBacklog,
} from "@shared/canonical-enrichment-backlog";
import { businessHasDbprLineageSql } from "./dbpr";
import { serperLookupExclusionSql } from "./cro03/sfp-serper-lookup-memory";
import { readUnlabeledDiscoveryGate } from "./cro03/sfp-serper-allowance";
import { resolveGeographyFromCandidates } from "./cro03/sfp-geography-resolver";
import { MATERIALIZATION_RULE_VERSION, HOLD_RETRY_HOURS, MAX_USABLE_CONTACTS_PER_BUSINESS }
  from "./free-discovery/staged-email-materialization";

const rows = (result: any): any[] => result?.rows ?? result ?? [];

/** The read model is a live aggregate over ~100k businesses and ~160k contacts, so it is cached briefly. */
export const BACKLOG_CACHE_SECONDS = 300;
const STATEMENT_TIMEOUT = "60s";
const RETRY_AFTER_DECISION_DAYS = 7;
const FREE_RECHECK_DAYS = 90;

/** Plain-language reason labels. Unknown codes fall back to a humanized form, never a hidden bucket. */
const REASON_LABELS: Record<string, string> = {
  awaiting_link_pass: "Waiting for the next business-link pass",
  LEGACY_CONTACT_FIELDS_ONLY: "Only the original contact fields exist; no independent evidence of the business",
  CANDIDATE_NOT_INDEPENDENTLY_CORROBORATED: "A candidate business exists but is not independently corroborated",
  GHL_ORGANIZATION_EVIDENCE_NOT_RETAINED: "The CRM record carries no retained organization evidence",
  MATERIALIZATION_RETAINED_REGISTRY_SOURCE_AMBIGUOUS: "The retained registry source matches more than one business",
  MATERIALIZATION_INDEPENDENT_ORGANIZATION_CORROBORATION_REQUIRED: "Independent organization corroboration is still required",
  identity_review_needed: "Waiting for an identity review",
  identity_quarantine: "Business identity is quarantined pending review",
  state_registry_lineage_excluded: "Excluded because of its state-registry lineage",
  do_not_visit: "Marked do-not-visit",
  not_a_target_vertical: "Classified outside the target verticals",
  conflicting_evidence: "Classification evidence conflicts",
  awaiting_first_classification: "No classification yet; website evidence is available",
  recent_decision_hold: "Classified recently; held before the next look",
  due_for_reconsideration: "Due for a fresh classification",
  vertical_not_in_active_program: "Vertical is not part of the active program",
  no_active_sequence_for_vertical: "No active sequence is bound to this vertical",
  awaiting_website_search: "Website search has not run yet",
  recent_search_remembered: "A recent website search found nothing usable; remembered until it expires",
  search_memory_expired: "An earlier website search has expired and can run again",
  unlabeled_search_closed: "No vertical yet, and the unlabeled website search is switched off",
  outside_program_territory: "Outside the program's territory",
  location_unresolved: "Location cannot be resolved to a county",
  has_usable_contact: "Already has a usable contact",
  staged_email_ready: "A found email address is ready to become a contact",
  staged_emails_held: "Found email addresses are held (see staged emails)",
  address_on_file_without_independent_link: "Address is on file but the contact has no independent business link",
  no_contact_for_address: "Address is on file but no contact holds it",
  awaiting_website_email_search: "Website email search has not run yet",
  website_email_search_failed_will_retry: "Website email search failed and will retry",
  website_email_search_failed_3_times: "Website email search failed three times",
  website_email_search_running: "Website email search is running",
  website_not_searchable: "Website could not be searched",
  website_searched_no_email_recheck: "Website searched, no usable email found; rechecked later",
  website_searched_no_email: "Website searched, no usable email found",
  contact_suppressed_or_invalid: "Contact is suppressed, opted out or has an invalid address",
  contact_has_no_email: "Contact has no email address",
  business_not_current: "Linked business is no longer current",
  ready_to_prepare: "Ready for the next recipient-selection pass",
  facts_changed_will_reprepare: "Facts changed; will be prepared again",
  awaiting_validation_request: "Validation has not been requested yet",
  answer_stored_awaiting_recipient_update: "The provider's valid answer is stored; the recipient has not been updated yet",
  answer_stored_address_not_deliverable: "The provider's not-deliverable answer is stored; the recipient has not been updated yet",
  address_failed_validation: "The provider rejected the address",
  provider_outcome_unconfirmed: "The provider outcome was never confirmed; held so it is not bought twice",
  provider_outcome_unconfirmed_shared_address: "Waiting behind an unconfirmed provider request for the same address",
  validation_in_progress: "Validation is running",
  queued_retry_later: "Validation is queued for a later retry",
  queued_for_validation: "Queued for validation",
  ready_held_outbound_paused: "Prepared and held; outbound is paused",
  business_already_has_three_usable_contacts: "The business already has three usable contacts",
  address_shared_by_several_businesses: "The same address was found for several businesses",
  business_not_canonical: "The business is not a current canonical business",
  linked: "Became a contact linked to its business",
  already_linked: "Already a contact linked to its business",
};

function humanize(code: string): string {
  const spaced = code.replace(/[_-]+/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
const labelFor = (code: string) => REASON_LABELS[code] ?? humanize(code);

const STAGE_COST: Record<BacklogStageKey, BacklogCostClass> = {
  link: "retained_evidence", identity: "free", website: "provider", vertical: "free",
  email: "free", recipient: "free", validation: "provider", ready: "free",
};

interface Slot { stage: BacklogStageKey; state: BacklogState; code: string }

const parseKey = (key: string): Slot => {
  const [stage, state, ...code] = key.split("|");
  return { stage: stage as BacklogStageKey, state: state as BacklogState, code: code.join("|") };
};

export interface ProgramScope { name: string | null; verticals: string[]; countyFips: string[] }

/**
 * Business-level next action. One CASE ladder, evaluated top to bottom, so every
 * business has exactly one current action and one reason. Mirrors the gates the
 * ordinary workers apply (quarantine, state-registry lineage, lookup memory,
 * evidence age, free email search status) rather than inventing new ones.
 */
function businessLadder(gateOpen: boolean) {
  const body = `CASE
    WHEN q THEN 'identity|held|identity_quarantine'
    WHEN has_dbpr THEN 'identity|held|state_registry_lineage_excluded'
    WHEN dnv THEN 'identity|held|do_not_visit'
    WHEN vstatus='excluded' THEN 'vertical|done|not_a_target_vertical'
    WHEN vstatus='conflicting' THEN 'vertical|held|conflicting_evidence'
    WHEN vstatus IN ('unresolved','missing') AND has_site THEN CASE
      WHEN last_class_at IS NULL THEN 'vertical|eligible_now|awaiting_first_classification'
      WHEN last_class_at > now() - interval '${RETRY_AFTER_DECISION_DAYS} days' THEN 'vertical|waiting|recent_decision_hold'
      ELSE 'vertical|retryable|due_for_reconsideration' END
    WHEN vstatus IN ('unresolved','missing') THEN CASE
      WHEN serper_fresh THEN 'website|waiting|recent_search_remembered'
      WHEN serper_any THEN 'website|retryable|search_memory_expired'
      WHEN NOT ${gateOpen ? "TRUE" : "FALSE"} THEN 'website|held|unlabeled_search_closed'
      ELSE 'website|eligible_now|awaiting_website_search' END
    WHEN NOT in_program THEN 'vertical|held|vertical_not_in_active_program'
    WHEN NOT has_binding THEN 'vertical|held|no_active_sequence_for_vertical'
    WHEN usable_contacts > 0 THEN 'email|done|has_usable_contact'
    WHEN staged_open > 0 THEN 'email|eligible_now|staged_email_ready'
    WHEN staged_n > 0 THEN 'email|held|staged_emails_held'
    WHEN has_main_email THEN 'email|held|address_on_file_without_independent_link'
    WHEN has_site THEN CASE
      WHEN fes IS NULL THEN 'email|eligible_now|awaiting_website_email_search'
      WHEN fes='failed' AND fea < 3 THEN 'email|retryable|website_email_search_failed_will_retry'
      WHEN fes='failed' THEN 'email|held|website_email_search_failed_3_times'
      WHEN fes='processing' THEN 'email|waiting|website_email_search_running'
      WHEN fes='skipped' THEN 'email|held|website_not_searchable'
      WHEN fes='enriched' AND fec < now() - interval '${FREE_RECHECK_DAYS} days' THEN 'email|retryable|website_searched_no_email_recheck'
      WHEN fes='enriched' THEN 'email|waiting|website_searched_no_email_recheck'
      ELSE 'email|held|website_not_searchable' END
    ELSE CASE
      WHEN serper_fresh THEN 'website|waiting|recent_search_remembered'
      WHEN serper_any THEN 'website|retryable|search_memory_expired'
      ELSE 'website|eligible_now|awaiting_website_search' END
  END`;
  return sql.raw(body);
}

/** Program verticals that have a live sequence or current package bound to them (same rule as recipient preparation). */
export function boundVerticalsCte() {
  return sql`bound_verticals AS MATERIALIZED (
    -- Same binding rule as recipient preparation: a live sequence that names the program vertical,
    -- or carries a current package for it. Evaluated once per vertical, not once per business.
    SELECT DISTINCT v.vertical FROM sfp_programs p
      CROSS JOIN LATERAL unnest(p.vertical_ids) AS v(vertical)
      JOIN follow_up_sequences seq ON seq.retired_at IS NULL AND (
        (seq.trigger_config->>'canonicalProgramId'=p.id::text AND seq.trigger_config->'canonicalVerticals' ? v.vertical)
        OR EXISTS(SELECT 1 FROM sfp_campaign_package_versions pkg WHERE pkg.sequence_id=seq.id
          AND pkg.lifecycle_state='current' AND ${sql.raw(contactTargetVerticalSql("pkg.vertical"))}=v.vertical))
     WHERE p.is_active AND p.taxonomy_version=2
  )`;
}

/** Per-business facts. Restricted to `idFilter` when given (contact queries only need linked businesses). */
function businessFacts(idFilter: ReturnType<typeof sql> | null, gateOpen: boolean) {
  const VERT = effectiveBusinessVerticalSql("bb");
  const STATUS = effectiveBusinessVerticalStatusSql("bb");
  return sql`
  facts AS MATERIALIZED (
    SELECT bb.id, ${sql.raw(STATUS)} AS vstatus,
      (NULLIF(btrim(bb.website_domain),'') IS NOT NULL) AS has_site,
      (NULLIF(btrim(bb.main_email),'') IS NOT NULL) AS has_main_email,
      CASE WHEN EXISTS(SELECT 1 FROM canonical_source_links l WHERE l.business_id=bb.id AND l.source_system='crm') THEN 'crm'
           WHEN EXISTS(SELECT 1 FROM canonical_source_links l WHERE l.business_id=bb.id AND l.source_system='sunbiz') THEN 'sunbiz'
           WHEN EXISTS(SELECT 1 FROM canonical_source_links l WHERE l.business_id=bb.id AND l.source_system='outscraper') THEN 'maps'
           ELSE 'other' END AS origin,
      EXISTS(SELECT 1 FROM sfp_identity_quarantines q WHERE q.business_id=bb.id AND q.cleared_at IS NULL) AS q,
      ${businessHasDbprLineageSql(sql`bb.id`)} AS has_dbpr,
      COALESCE(bb.do_not_visit,FALSE) AS dnv,
      (SELECT max(ev.created_at) FROM sfp_classification_evidence ev WHERE ev.business_id=bb.id
         AND ev.taxonomy_version=2 AND ev.classifier_version=3 AND ev.terminal_state='completed') AS last_class_at,
      ${serperLookupExclusionSql("bb")} AS serper_fresh,
      EXISTS(SELECT 1 FROM sfp_serper_lookup_memory m WHERE m.business_id=bb.id) AS serper_any,
      bb.free_enrichment_status AS fes, COALESCE(bb.free_enrichment_attempt_count,0) AS fea,
      bb.free_enrichment_completed_at AS fec,
      bb.state AS gstate, bb.postal_code AS gzip, bb.city AS gcity,
      (SELECT jsonb_agg(jsonb_build_object('id',bl.id,'is_primary',bl.is_primary,'city',bl.city,'state',bl.state,
         'postal_code',bl.postal_code,'county_fips',bl.county_fips) ORDER BY bl.id)
         FROM business_locations bl WHERE bl.business_id=bb.id)::text AS glocs,
      COALESCE(ua.n,0) AS usable_contacts, COALESCE(sa.total,0) AS staged_n, COALESCE(sa.open,0) AS staged_open,
      CASE WHEN ${sql.raw(STATUS)}='mapped' THEN ${sql.raw(VERT)} END AS vid
    FROM businesses bb
    LEFT JOIN (SELECT c.business_id, count(*) n FROM contacts c
        WHERE c.archived_at IS NULL AND c.email IS NOT NULL AND COALESCE(c.do_not_contact,FALSE)=FALSE
          AND COALESCE(c.opted_out_email,FALSE)=FALSE AND COALESCE(c.bounce_status,'none')<>'hard'
          AND COALESCE(c.email_status,'unvalidated') NOT IN ('invalid','bounced','unsafe','opted_out')
          AND c.suppression_reason IS NULL AND c.business_id IS NOT NULL GROUP BY c.business_id) ua ON ua.business_id=bb.id
    LEFT JOIN (SELECT f.business_id, count(*) total,
        count(*) FILTER (WHERE o.candidate_id IS NULL
          OR (o.outcome='held' AND (o.rule_version<>${MATERIALIZATION_RULE_VERSION}
              OR o.evaluated_at<now()-make_interval(hours=>${HOLD_RETRY_HOURS})))) open
        FROM free_discovery_candidates f
        LEFT JOIN free_discovery_materialization_outcomes o ON o.candidate_id=f.id
        WHERE f.field='email' AND f.disposition='staged' AND f.subject_type='business'
          AND f.business_id IS NOT NULL AND f.promoted_at IS NULL
          AND COALESCE(o.outcome,'') NOT IN ('linked','already_linked') GROUP BY f.business_id) sa ON sa.business_id=bb.id
    WHERE bb.record_class='canonical' ${idFilter ? sql`AND bb.id IN (${idFilter})` : sql``}
  ), ${boundVerticalsCte()}, bound AS (
    SELECT f.*,
      (f.vid IS NOT NULL AND EXISTS(SELECT 1 FROM sfp_programs p WHERE p.is_active AND p.taxonomy_version=2
         AND f.vid=ANY(p.vertical_ids))) AS in_program,
      (f.vid IN (SELECT vertical FROM bound_verticals)) AS has_binding
    FROM facts f
  ), keyed AS (
    SELECT bound.*, ${businessLadder(gateOpen)} AS bk FROM bound
  )`;
}

type Tally = Map<string, Map<string, number>>;
const bump = (tally: Tally, family: string, key: string, n: number) => {
  const inner = tally.get(family) ?? new Map<string, number>();
  inner.set(key, (inner.get(key) ?? 0) + n);
  tally.set(family, inner);
};

/** Resolve a business to a county with the same resolver provider selection and recipient preparation use. */
export function resolveBusinessCounty(
  g: { gstate: string | null; gzip: string | null; gcity: string | null; glocs: string | null },
): { outcome: "resolved" | "unresolved"; countyFips: string | null } {
  const locations: any[] = g.glocs ? JSON.parse(g.glocs) : [];
  const resolution = resolveGeographyFromCandidates([
    ...locations.map(l => ({
      locationId: Number(l.id), isPrimary: l.is_primary === true, city: l.city, state: l.state,
      postalCode: l.postal_code, countyFips: l.county_fips,
    })),
    { locationId: null, isPrimary: false, city: g.gcity, state: g.gstate, postalCode: g.gzip, countyFips: null },
  ]);
  if (resolution.outcome !== "resolved" || !resolution.eligible || !resolution.countyFips) {
    return { outcome: "unresolved", countyFips: null };
  }
  return { outcome: "resolved", countyFips: resolution.countyFips };
}

/** Territory check identical to the one provider selection and recipient preparation apply. */
function territory(
  g: { gstate: string | null; gzip: string | null; gcity: string | null; glocs: string | null },
  countyFips: string[],
): "in" | "outside" | "unresolved" {
  const r = resolveBusinessCounty(g);
  if (r.outcome !== "resolved" || !r.countyFips) return "unresolved";
  return countyFips.includes(r.countyFips) ? "in" : "outside";
}

const FAMILY_META: Record<string, { label: string; unit: string; handoff: string }> = {
  crm_ghl: { label: "CRM / GoHighLevel contacts", unit: "contacts",
    handoff: "Business linking, then recipient selection, run automatically each scheduled cycle." },
  uploaded: { label: "Uploaded lead files", unit: "contacts",
    handoff: "Business linking uses the retained original rows; later stages run automatically." },
  other: { label: "Other contacts", unit: "contacts",
    handoff: "Business linking, then recipient selection, run automatically each scheduled cycle." },
  sunbiz: { label: "Businesses from state registry records", unit: "businesses",
    handoff: "Classification, website and email search, then staged-email linking, run automatically." },
  maps: { label: "Businesses from map-provider records", unit: "businesses",
    handoff: "Classification, website and email search, then staged-email linking, run automatically." },
  crm: { label: "Businesses from CRM records", unit: "businesses",
    handoff: "Classification, website and email search, then staged-email linking, run automatically." },
  other_business: { label: "Other existing businesses", unit: "businesses",
    handoff: "Classification, website and email search, then staged-email linking, run automatically." },
  business_email: { label: "Email addresses already on a business", unit: "businesses",
    handoff: "The address becomes usable once its contact has an independent business link." },
  staged_email: { label: "Emails found by website crawling (staged)", unit: "email addresses",
    handoff: "Each page of 100 becomes a contact linked to its exact business, then recipient selection." },
  registry: { label: "State registry records with a website or email", unit: "records",
    handoff: "Registry records become businesses through the automatic registry backfill." },
};
const FAMILY_ORDER = ["crm_ghl", "uploaded", "other", "sunbiz", "maps", "crm", "other_business",
  "business_email", "staged_email", "registry"];

async function readProgram(): Promise<ProgramScope | null> {
  const p = rows(await db.execute(sql`SELECT name, vertical_ids, county_fips FROM sfp_programs
    WHERE is_active AND taxonomy_version=2 ORDER BY created_at LIMIT 1`))[0];
  if (!p) return null;
  return { name: p.name ?? null, verticals: (p.vertical_ids ?? []).map(String), countyFips: (p.county_fips ?? []).map(String) };
}

export async function computeCanonicalEnrichmentBacklog(): Promise<CanonicalEnrichmentBacklog> {
  const gate = await readUnlabeledDiscoveryGate();
  const program = await readProgram();
  const counties = program?.countyFips ?? [];
  const tally: Tally = new Map();

  const result = await db.transaction(async tx => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout='${STATEMENT_TIMEOUT}'`));

    // 1) Businesses: one current action each, grouped by origin.
    const businessRows = rows(await tx.execute(sql`
      WITH ${businessFacts(null, gate.enabled)}
      SELECT origin, bk AS k,
        CASE WHEN (bk LIKE 'website|eligible_now|%' OR bk LIKE 'website|retryable|%') THEN gstate END AS gs,
        CASE WHEN (bk LIKE 'website|eligible_now|%' OR bk LIKE 'website|retryable|%') THEN gzip END AS gz,
        CASE WHEN (bk LIKE 'website|eligible_now|%' OR bk LIKE 'website|retryable|%') THEN gcity END AS gc,
        CASE WHEN (bk LIKE 'website|eligible_now|%' OR bk LIKE 'website|retryable|%') THEN glocs END AS gl,
        count(*)::int AS n
      FROM keyed GROUP BY 1,2,3,4,5,6`));
    for (const r of businessRows) {
      let key = String(r.k);
      const slot = parseKey(key);
      if (slot.stage === "website" && (slot.state === "eligible_now" || slot.state === "retryable")) {
        const t = territory({ gstate: r.gs, gzip: r.gz, gcity: r.gc, glocs: r.gl }, counties);
        if (t !== "in") key = `website|held|${t === "outside" ? "outside_program_territory" : "location_unresolved"}`;
      }
      bump(tally, r.origin === "other" ? "other_business" : String(r.origin), key, Number(r.n));
    }

    // 2) Contacts: each contact's current action, through its business when linked.
    const contactRows = rows(await tx.execute(sql`
      WITH linked AS MATERIALIZED (
        SELECT DISTINCT d.contact_id, d.business_id FROM contact_business_link_decisions d
         WHERE d.decision='verified' AND d.superseded_at IS NULL),
      ${businessFacts(sql`SELECT business_id FROM linked`, gate.enabled)},
      uploaded AS MATERIALIZED (SELECT DISTINCT contact_id FROM import_row_dispositions WHERE contact_id IS NOT NULL),
      cc AS MATERIALIZED (
        SELECT c.id, c.business_id, (c.email IS NOT NULL AND btrim(c.email)<>'') AS has_email,
          CASE WHEN c.ghl_contact_id IS NOT NULL THEN 'crm_ghl'
               WHEN u.contact_id IS NOT NULL OR c.primary_source_type='historical_backfill' THEN 'uploaded'
               ELSE 'other' END AS fam,
          (COALESCE(c.do_not_contact,FALSE) OR COALESCE(c.do_not_auto_contact,FALSE) OR COALESCE(c.opted_out_email,FALSE)
            OR COALESCE(c.bounce_status,'none')='hard' OR c.suppression_reason IS NOT NULL
            OR COALESCE(c.email_status,'unvalidated') IN ('invalid','bounced','unsafe','opted_out')) AS suppressed,
          (l.contact_id IS NOT NULL) AS is_linked,
          disp.outcome, disp.reason_code, disp.next_retry_at,
          prep.preparation_state, prep.reason_code AS prep_reason,
          vi.state AS vi_state, vi.terminal_code AS vi_code, vi.next_attempt_at AS vi_next,
          vi.updated_at AS vi_updated, vi.created_at AS vi_created
        FROM contacts c
        LEFT JOIN linked l ON l.contact_id=c.id AND l.business_id=c.business_id
        LEFT JOIN uploaded u ON u.contact_id=c.id
        LEFT JOIN contact_business_link_dispositions disp ON disp.contact_id=c.id
        LEFT JOIN LATERAL (SELECT i.preparation_state, i.reason_code FROM cr04_enrollment_intents i
           WHERE i.contact_id=c.id AND i.program_id IS NOT NULL AND l.contact_id IS NOT NULL
           ORDER BY i.created_at DESC LIMIT 1) prep ON TRUE
        LEFT JOIN LATERAL (SELECT v.state, v.terminal_code, v.next_attempt_at, v.updated_at, v.created_at
           FROM validation_intents v WHERE v.contact_id=c.id AND prep.preparation_state='pending_validation'
           ORDER BY v.created_at DESC LIMIT 1) vi ON TRUE
        WHERE c.record_class='production' AND c.archived_at IS NULL)
      SELECT fam, k, gs, gz, gc, gl, count(*)::int AS n FROM (
        SELECT cc.fam,
          CASE
            WHEN NOT cc.is_linked THEN CASE
              WHEN cc.outcome IS NULL THEN 'link|eligible_now|awaiting_link_pass'
              WHEN cc.outcome='awaiting_review' THEN 'link|held|' || COALESCE(cc.reason_code,'identity_review_needed')
              WHEN cc.next_retry_at IS NOT NULL AND cc.next_retry_at>now() THEN 'link|waiting|' || COALESCE(cc.reason_code,'unknown')
              WHEN cc.next_retry_at IS NOT NULL THEN 'link|retryable|' || COALESCE(cc.reason_code,'unknown')
              ELSE 'link|held|' || COALESCE(cc.reason_code,'unknown') END
            WHEN cc.preparation_state='ready_held' THEN 'ready|done|ready_held_outbound_paused'
            WHEN cc.suppressed THEN 'recipient|held|contact_suppressed_or_invalid'
            WHEN NOT cc.has_email THEN 'email|held|contact_has_no_email'
            WHEN bd.id IS NULL THEN 'link|held|business_not_current'
            WHEN bd.vstatus<>'mapped' OR NOT bd.in_program OR NOT bd.has_binding THEN bd.bk
            WHEN cc.preparation_state='pending_validation' THEN CASE
              WHEN cc.vi_state IS NULL THEN 'validation|eligible_now|awaiting_validation_request'
              WHEN cc.vi_state='completed' AND cc.vi_code='non_positive' THEN 'validation|eligible_now|answer_stored_address_not_deliverable'
              WHEN cc.vi_state='completed' THEN 'validation|eligible_now|answer_stored_awaiting_recipient_update'
              WHEN cc.vi_state='blocked' AND cc.vi_code='non_positive' THEN 'validation|held|address_failed_validation'
              WHEN cc.vi_state='blocked' AND cc.vi_code='ambiguous_billing' THEN 'validation|held|provider_outcome_unconfirmed'
              WHEN cc.vi_state='blocked' THEN 'validation|held|' || COALESCE(cc.vi_code,'blocked')
              WHEN cc.vi_code='shared_address_validation_in_flight' AND cc.vi_created < now()-interval '1 day'
                THEN 'validation|held|provider_outcome_unconfirmed_shared_address'
              WHEN cc.vi_state='processing' AND cc.vi_updated < now()-interval '1 hour'
                THEN 'validation|held|provider_outcome_unconfirmed'
              WHEN cc.vi_state='processing' THEN 'validation|waiting|validation_in_progress'
              WHEN cc.vi_next>now() THEN 'validation|waiting|queued_retry_later'
              ELSE 'validation|eligible_now|queued_for_validation' END
            WHEN cc.preparation_state='exception' THEN 'recipient|retryable|facts_changed_will_reprepare'
            WHEN cc.preparation_state='rejected' THEN 'recipient|held|' || lower(COALESCE(cc.prep_reason,'preparation_rejected'))
            ELSE 'recipient|geo_check|ready_to_prepare' END AS k,
          CASE WHEN cc.is_linked AND bd.vstatus='mapped' AND bd.in_program AND bd.has_binding AND cc.preparation_state IS NULL
                 AND NOT cc.suppressed AND cc.has_email THEN bd.gstate END AS gs,
          CASE WHEN cc.is_linked AND bd.vstatus='mapped' AND bd.in_program AND bd.has_binding AND cc.preparation_state IS NULL
                 AND NOT cc.suppressed AND cc.has_email THEN bd.gzip END AS gz,
          CASE WHEN cc.is_linked AND bd.vstatus='mapped' AND bd.in_program AND bd.has_binding AND cc.preparation_state IS NULL
                 AND NOT cc.suppressed AND cc.has_email THEN bd.gcity END AS gc,
          CASE WHEN cc.is_linked AND bd.vstatus='mapped' AND bd.in_program AND bd.has_binding AND cc.preparation_state IS NULL
                 AND NOT cc.suppressed AND cc.has_email THEN bd.glocs END AS gl
        FROM cc LEFT JOIN keyed bd ON bd.id=cc.business_id AND cc.is_linked) y
      GROUP BY 1,2,3,4,5,6`));
    for (const r of contactRows) {
      let key = String(r.k);
      if (key === "recipient|geo_check|ready_to_prepare") {
        const t = territory({ gstate: r.gs, gzip: r.gz, gcity: r.gc, glocs: r.gl }, counties);
        key = t === "in" ? "recipient|eligible_now|ready_to_prepare"
          : `recipient|held|${t === "outside" ? "outside_program_territory" : "location_unresolved"}`;
      }
      bump(tally, String(r.fam), key, Number(r.n));
    }

    // 3) Addresses already on a business.
    const emailRows = rows(await tx.execute(sql`
      SELECT CASE WHEN c_here.id IS NOT NULL THEN 'email|done|has_usable_contact'
                  WHEN c_any.id IS NULL THEN 'email|held|no_contact_for_address'
                  ELSE 'link|held|' || COALESCE(disp.reason_code, 'awaiting_link_pass') END AS k,
             count(*)::int AS n
      FROM businesses b
      LEFT JOIN LATERAL (SELECT c.id FROM contacts c WHERE lower(btrim(c.email))=lower(btrim(b.main_email))
         AND c.business_id=b.id AND c.archived_at IS NULL LIMIT 1) c_here ON TRUE
      LEFT JOIN LATERAL (SELECT c.id FROM contacts c WHERE lower(btrim(c.email))=lower(btrim(b.main_email))
         AND c.archived_at IS NULL ORDER BY (c.business_id IS NULL) DESC, c.id LIMIT 1) c_any ON TRUE
      LEFT JOIN contact_business_link_dispositions disp ON disp.contact_id=c_any.id
      WHERE b.record_class='canonical' AND NULLIF(btrim(b.main_email),'')<>'' GROUP BY 1`));
    for (const r of emailRows) bump(tally, "business_email", String(r.k), Number(r.n));

    // 4) Staged crawl emails, using the same gates as the materializer.
    const stagedRows = rows(await tx.execute(sql`
      WITH shared AS MATERIALIZED (
        SELECT normalized_value_hash FROM free_discovery_candidates
         WHERE field='email' AND disposition='staged' AND subject_type='business' AND business_id IS NOT NULL
         GROUP BY 1 HAVING count(DISTINCT business_id)>1),
      usable AS MATERIALIZED (
        SELECT c.business_id, count(*) n FROM contacts c
         WHERE c.archived_at IS NULL AND c.business_id IS NOT NULL AND COALESCE(c.do_not_contact,FALSE)=FALSE
           AND COALESCE(c.opted_out_email,FALSE)=FALSE AND COALESCE(c.bounce_status,'none')<>'hard'
           AND COALESCE(c.email_status,'unvalidated') NOT IN ('invalid','bounced','unsafe','opted_out')
           AND c.suppression_reason IS NULL GROUP BY c.business_id)
      SELECT CASE
          WHEN o.outcome IN ('linked','already_linked') THEN 'email|done|' || o.outcome
          WHEN b.id IS NULL OR COALESCE(b.do_not_visit,FALSE) THEN 'email|held|business_not_canonical'
          WHEN ${businessHasDbprLineageSql(sql`b.id`)} THEN 'identity|held|state_registry_lineage_excluded'
          WHEN EXISTS(SELECT 1 FROM sfp_identity_quarantines q WHERE q.business_id=b.id AND q.cleared_at IS NULL)
            THEN 'identity|held|identity_quarantine'
          WHEN f.normalized_value_hash IN (SELECT normalized_value_hash FROM shared)
            THEN 'email|held|address_shared_by_several_businesses'
          WHEN o.outcome='held' AND o.rule_version=${MATERIALIZATION_RULE_VERSION}
            AND o.evaluated_at>=now()-make_interval(hours=>${HOLD_RETRY_HOURS}) THEN 'email|waiting|' || COALESCE(o.reason_code,'held')
          WHEN o.outcome='held' THEN 'email|retryable|' || COALESCE(o.reason_code,'held')
          WHEN COALESCE(u.n,0)>=${MAX_USABLE_CONTACTS_PER_BUSINESS} THEN 'email|held|business_already_has_three_usable_contacts'
          ELSE 'email|eligible_now|staged_email_ready' END AS k,
        count(*)::int AS n
      FROM free_discovery_candidates f
      LEFT JOIN free_discovery_materialization_outcomes o ON o.candidate_id=f.id
      LEFT JOIN businesses b ON b.id=f.business_id AND b.record_class='canonical'
      LEFT JOIN usable u ON u.business_id=f.business_id
      WHERE f.field='email' AND f.disposition='staged' AND f.subject_type='business'
        AND f.business_id IS NOT NULL AND f.promoted_at IS NULL
      GROUP BY 1`));
    for (const r of stagedRows) bump(tally, "staged_email", String(r.k), Number(r.n));

    // 5) State registry records that carry a website or email.
    const registryRows = rows(await tx.execute(sql`
      SELECT CASE WHEN cl.id IS NULL THEN 'link|eligible_now|awaiting_registry_backfill'
                  WHEN cl.status IN ('created','matched_existing') THEN 'link|done|' || cl.status
                  WHEN cl.status='claimed' THEN 'link|waiting|registry_claim_in_progress'
                  ELSE 'link|held|' || COALESCE(cl.deferred_reason_code, cl.status) END AS k,
             count(*)::int AS n
      FROM sunbiz_entities se
      LEFT JOIN sunbiz_bootstrap_claims cl ON cl.filing_number=se.filing_number
      WHERE NULLIF(btrim(se.website),'') IS NOT NULL OR NULLIF(btrim(se.email),'') IS NOT NULL
      GROUP BY 1`));
    for (const r of registryRows) bump(tally, "registry", String(r.k), Number(r.n));

    // Funnel and the counts kept apart from it.
    const funnel = rows(await tx.execute(sql`
      WITH linked AS MATERIALIZED (
        SELECT DISTINCT d.contact_id, d.business_id FROM contact_business_link_decisions d
          JOIN contacts c ON c.id=d.contact_id AND c.business_id=d.business_id AND c.record_class='production' AND c.archived_at IS NULL
          JOIN businesses b ON b.id=d.business_id AND b.record_class='canonical'
         WHERE d.decision='verified' AND d.superseded_at IS NULL)
      SELECT (SELECT count(*) FROM linked)::int AS link_contacts,
        (SELECT count(DISTINCT business_id) FROM linked)::int AS link_businesses,
        (SELECT count(*) FROM (SELECT ${sql.raw(effectiveBusinessVerticalStatusSql("b"))} s FROM businesses b
           WHERE b.record_class='canonical') x WHERE s='mapped')::int AS mapped_businesses,
        (SELECT count(DISTINCT l.business_id) FROM linked l JOIN businesses b ON b.id=l.business_id
           WHERE ${sql.raw(effectiveBusinessVerticalStatusSql("b"))}='mapped')::int AS mapped_with_link,
        (SELECT count(DISTINCT contact_id) FROM cr04_enrollment_intents WHERE program_id IS NOT NULL
           AND preparation_state IN ('pending_validation','ready_held'))::int AS selected,
        (SELECT count(DISTINCT contact_id) FROM cr04_enrollment_intents WHERE program_id IS NOT NULL
           AND preparation_state='pending_validation')::int AS pending,
        (SELECT count(DISTINCT contact_id) FROM cr04_enrollment_intents WHERE program_id IS NOT NULL
           AND preparation_state='ready_held')::int AS ready`))[0];
    const receipts = rows(await tx.execute(sql`SELECT disposition AS k, count(*)::int AS n
      FROM import_row_dispositions GROUP BY 1`));
    const providerOps = rows(await tx.execute(sql`SELECT provider, state, count(*)::int AS n
      FROM provider_operations WHERE provider IN ('zerobounce','serper') GROUP BY 1,2`));
    const zb = rows(await tx.execute(sql`SELECT outcome, count(*)::int AS n FROM provider_observations
      WHERE provider='zerobounce' AND retryable=FALSE AND outcome IN ('valid','invalid') GROUP BY 1`));
    const serper = rows(await tx.execute(sql`SELECT lifetime_calls, yield_websites FROM serper_control LIMIT 1`))[0];
    return { funnel, receipts, providerOps, zb, serper };
  });

  const { funnel, receipts, providerOps, zb, serper } = result;

  // Assemble families.
  const families: BacklogFamily[] = [];
  for (const key of FAMILY_ORDER) {
    const inner = tally.get(key);
    if (!inner) continue;
    const meta = FAMILY_META[key];
    const summaries = new Map<BacklogStageKey, BacklogFamily["stages"][number]>();
    const reasons: BacklogReasonCount[] = [];
    let total = 0;
    for (const [slotKey, count] of inner) {
      const slot = parseKey(slotKey);
      total += count;
      const entry = summaries.get(slot.stage) ?? {
        stage: slot.stage, label: BACKLOG_STAGE_LABELS[slot.stage], cost: STAGE_COST[slot.stage],
        eligible_now: 0, waiting: 0, retryable: 0, held: 0, done: 0,
      };
      entry[slot.state] += count;
      summaries.set(slot.stage, entry);
      reasons.push({ stage: slot.stage, state: slot.state, code: slot.code, label: labelFor(slot.code), count });
    }
    reasons.sort((a, b) => b.count - a.count);
    families.push({
      key, label: meta.label, unit: meta.unit, total, handoff: meta.handoff,
      stages: BACKLOG_STAGE_ORDER.filter(s => summaries.has(s)).map(s => summaries.get(s)!),
      reasons,
    });
  }

  // Priority: retained evidence first, then free work, then provider work ranked by what has been measured.
  // Each count comes from the families whose unit matches the action, so contacts and businesses are never added together.
  const CONTACT_FAMILIES = ["crm_ghl", "uploaded", "other"];
  const BUSINESS_FAMILIES = ["sunbiz", "maps", "crm", "other_business"];
  const eligible = (fams: string[], stage: BacklogStageKey, code?: string | string[]) => fams.reduce((total, fam) =>
    total + [...(tally.get(fam) ?? [])].reduce((sum, [slotKey, count]) => {
      const slot = parseKey(slotKey);
      return slot.state === "eligible_now" && slot.stage === stage && (!code || [code].flat().includes(slot.code)) ? sum + count : sum;
    }, 0), 0);
  const zbValid = Number(zb.find((r: any) => r.outcome === "valid")?.n ?? 0);
  const zbInvalid = Number(zb.find((r: any) => r.outcome === "invalid")?.n ?? 0);
  const serperCalls = Number(serper?.lifetime_calls ?? 0);
  const serperWebsites = Number(serper?.yield_websites ?? 0);
  const items: Omit<BacklogPriorityItem, "rank">[] = [
    { stage: "email", label: "Turn found email addresses into contacts linked to their business", cost: "retained_evidence",
      unit: "email addresses", eligibleNow: eligible(["staged_email"], "email", "staged_email_ready"), observed: null,
      rationale: "Uses emails already found and stored. No provider call." },
    { stage: "link", label: BACKLOG_STAGE_LABELS.link, cost: "retained_evidence", unit: "contacts",
      eligibleNow: eligible(CONTACT_FAMILIES, "link"), observed: null,
      rationale: "Uses retained original rows and registry evidence. No provider call." },
    { stage: "validation", label: "Apply stored validation answers to recipients", cost: "free", unit: "contacts",
      eligibleNow: eligible(CONTACT_FAMILIES, "validation",
        ["answer_stored_awaiting_recipient_update", "answer_stored_address_not_deliverable"]), observed: null,
      rationale: "The provider already answered and the answer is stored. Applying it costs nothing and buys nothing." },
    { stage: "recipient", label: BACKLOG_STAGE_LABELS.recipient, cost: "free", unit: "contacts",
      eligibleNow: eligible(CONTACT_FAMILIES, "recipient"), observed: null,
      rationale: "Local selection from contacts already linked to an accepted-vertical business in territory." },
    { stage: "vertical", label: BACKLOG_STAGE_LABELS.vertical, cost: "free", unit: "businesses",
      eligibleNow: eligible(BUSINESS_FAMILIES, "vertical"), observed: null,
      rationale: "Classifies from website evidence already collected, within the existing free limits." },
    { stage: "email", label: "Search business websites for an email address", cost: "free", unit: "businesses",
      eligibleNow: eligible(BUSINESS_FAMILIES, "email", "awaiting_website_email_search"), observed: null,
      rationale: "First-party website search; no paid provider." },
  ];
  const providerItems = ([
    { stage: "validation", label: BACKLOG_STAGE_LABELS.validation, cost: "provider" as const, unit: "contacts",
      eligibleNow: eligible(CONTACT_FAMILIES, "validation", ["awaiting_validation_request", "queued_for_validation"]),
      observed: zbValid + zbInvalid > 0 ? {
        description: "Addresses the provider has answered definitively so far: valid out of all answered",
        numerator: zbValid, denominator: zbValid + zbInvalid } : null,
      rationale: "Paid per address; results already received are reused rather than bought again." },
    { stage: "website", label: BACKLOG_STAGE_LABELS.website, cost: "provider" as const, unit: "businesses",
      eligibleNow: eligible(BUSINESS_FAMILIES, "website"),
      observed: serperCalls > 0 ? {
        description: "Websites found per search request over the life of the provider control",
        numerator: serperWebsites, denominator: serperCalls } : null,
      rationale: "Paid per search; remembered outcomes are not repeated, and searches without a vertical stay off until enabled." },
  ] as Omit<BacklogPriorityItem, "rank">[]).sort((a, b) => {
    const ra = a.observed ? a.observed.numerator / a.observed.denominator : -1;
    const rb = b.observed ? b.observed.numerator / b.observed.denominator : -1;
    return rb - ra;
  });
  const priority: BacklogPriorityItem[] = [...items, ...providerItems]
    .filter(i => i.eligibleNow > 0)
    .map((i, index) => ({ ...i, rank: index + 1 }));

  const opsByProvider: Record<string, Record<string, number>> = {};
  for (const r of providerOps) (opsByProvider[String(r.provider)] ??= {})[String(r.state)] = Number(r.n);

  let pause = { state: "unknown", note: "Pause state could not be read." };
  try {
    const { getPauseState } = await import("./outbound-pause-authority");
    const s = await getPauseState();
    pause = { state: s.state, note: s.state === "paused"
      ? "Outbound is paused. Nothing on this page sends or enrolls anyone."
      : "Outbound is not fully paused; this page still sends nothing." };
  } catch { /* keep the explicit unknown state */ }

  return {
    observedAt: new Date().toISOString(),
    maxAgeSeconds: BACKLOG_CACHE_SECONDS,
    funnel: {
      supportedBusinessLinks: { contacts: Number(funnel.link_contacts), businesses: Number(funnel.link_businesses) },
      currentAcceptedVerticals: { businesses: Number(funnel.mapped_businesses), withSupportedLinkedContact: Number(funnel.mapped_with_link) },
      selectedRecipients: Number(funnel.selected), pendingValidation: Number(funnel.pending), readyHeld: Number(funnel.ready),
    },
    families, priority,
    separate: {
      originalRowReceipts: Object.fromEntries(receipts.map((r: any) => [String(r.k), Number(r.n)])),
      providerOperations: opsByProvider,
      sendingAuthority: pause,
    },
    program,
    notes: [
      "Each record appears once, under the single action it is waiting on.",
      "Eligible now means the ordinary workers can pick it up on their next pass; it is not a forecast of how many will succeed.",
      "Observed provider results are measurements to date. They are not guaranteed yield and not an actual charge.",
      "Original-row receipts, provider operations and sending authority are separate from the funnel.",
      `A website search or recipient selection also needs the business inside the program territory${counties.length ? ` (${counties.length} counties)` : ""}.`,
    ],
  };
}

let cache: { at: number; value: CanonicalEnrichmentBacklog } | null = null;
let inflight: Promise<CanonicalEnrichmentBacklog> | null = null;

/** Cached, single-flight read. A failed refresh never serves a made-up number. */
export async function readCanonicalEnrichmentBacklog(opts: { fresh?: boolean } = {}): Promise<CanonicalEnrichmentBacklog> {
  if (!opts.fresh && cache && Date.now() - cache.at < BACKLOG_CACHE_SECONDS * 1000) return cache.value;
  if (!inflight) {
    inflight = computeCanonicalEnrichmentBacklog()
      .then(value => { cache = { at: Date.now(), value }; return value; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

export function resetCanonicalEnrichmentBacklogCache() { cache = null; }
