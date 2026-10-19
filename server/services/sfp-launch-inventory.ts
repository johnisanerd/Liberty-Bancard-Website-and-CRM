import { sql } from "drizzle-orm";
import { db } from "../db";
import { effectiveBusinessVerticalSql, effectiveBusinessVerticalStatusSql } from "@shared/effective-vertical";
import {
  LAUNCH_GATE_LABELS,
  type LaunchCountyVerticalCell, type LaunchGateKey, type LaunchInventoryPopulation,
  type LaunchReasonCount, type LaunchReleaseBlocker, type SfpLaunchInventory,
} from "@shared/sfp-launch-inventory";
import { boundVerticalsCte, resolveBusinessCounty } from "./canonical-enrichment-backlog";
import { getActiveSfpOutreachPolicy } from "./cro03/sfp-outreach-policy";
import { evaluateContactDecisions } from "./contactability";
import { decideCr06PromotionalLifecycle } from "./cr06-promotional-lifecycle-decision";
import { isUsableSenderIdentity, remainingDailyCapacity } from "./sdr/sender-identity-state";

const rows = (result: any): any[] => result?.rows ?? result ?? [];
export const LAUNCH_INVENTORY_CACHE_SECONDS = 600;
const COUNTY_NAMES: Record<string, string> = { "12011": "Broward", "12086": "Miami-Dade", "12099": "Palm Beach" };
const POLICY_CONCURRENCY = 4;

const CODE_LABELS: Record<string, string> = {
  contact_unavailable: "Contact is archived, suppressed, opted out or not a production contact",
  address_marked_undeliverable: "The contact's email is already marked invalid, bounced, unsafe or opted out",
  address_changed: "The email address changed after it was prepared",
  link_not_current: "The contact no longer has a current verified link to this business",
  business_not_current: "The business is no longer a current canonical business",
  vertical_not_accepted: "The business has no current accepted vertical in the program",
  no_live_sequence: "No live sequence is bound to the business's vertical",
  outside_territory: "The business is outside the three program counties",
  location_unresolved: "The business location cannot be resolved to a county",
  no_fresh_validation: "No fresh valid address validation is on file (expired or never completed)",
  validation_not_valid: "The latest validation answer is not valid",
  membership_missing: "The owned sequence membership is missing",
  already_released: "Already released by an operator; it is no longer held",
  membership_not_paused: "The owned sequence membership is not paused",
  membership_not_owned: "The sequence membership does not belong to this preparation",
};
const labelFor = (code: string) => CODE_LABELS[code]
  ?? (code.charAt(0).toUpperCase() + code.slice(1).toLowerCase().replace(/[_-]+/g, " "));

interface Row {
  id: string; state: "ready_held" | "pending_validation"; contactId: number; businessId: number;
  sequenceId: number | null; enrollmentId: number | null;
  failure: { gate: LaunchGateKey; code: string } | null;
  county: string | null; vertical: string | null;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; out[index] = await fn(items[index]); }
  }));
  return out;
}

async function evaluateLaunchRows(): Promise<{ results: Row[] }> {
  const policy = await getActiveSfpOutreachPolicy({ bypassCache: true });
  const programRow = rows(await db.execute(sql`SELECT county_fips FROM sfp_programs
    WHERE is_active AND taxonomy_version=2 ORDER BY created_at LIMIT 1`))[0];
  const counties: string[] = (programRow?.county_fips ?? []).map(String);
  const VERT = effectiveBusinessVerticalSql("b");
  const STATUS = effectiveBusinessVerticalStatusSql("b");

  const recordedQuery = sql`
    WITH ${boundVerticalsCte()}
    SELECT i.id::text AS id, i.preparation_state AS state, i.contact_id, i.business_id, i.sequence_id, i.enrollment_id,
      (c.id IS NOT NULL AND c.record_class='production' AND c.archived_at IS NULL
        AND COALESCE(c.do_not_contact,FALSE)=FALSE AND COALESCE(c.do_not_auto_contact,FALSE)=FALSE
        AND COALESCE(c.opted_out_email,FALSE)=FALSE AND COALESCE(c.bounce_status,'none')<>'hard'
        AND c.suppression_reason IS NULL AND c.email IS NOT NULL) AS contact_ok,
      (COALESCE(c.email_status,'unvalidated') NOT IN ('invalid','bounced','unsafe','opted_out')) AS status_ok,
      (encode(sha256(convert_to(lower(trim(c.email)),'UTF8')),'hex') = i.normalized_email_hash) AS address_ok,
      (c.business_id IS NOT DISTINCT FROM i.business_id AND EXISTS(SELECT 1 FROM contact_business_link_decisions d
         WHERE d.contact_id=i.contact_id AND d.business_id=i.business_id
           AND d.decision='verified' AND d.superseded_at IS NULL)) AS link_ok,
      (b.id IS NOT NULL AND b.record_class='canonical' AND COALESCE(b.do_not_visit,FALSE)=FALSE) AS business_ok,
      (${sql.raw(STATUS)}='mapped' AND EXISTS(SELECT 1 FROM sfp_programs p WHERE p.is_active AND p.taxonomy_version=2
         AND ${sql.raw(VERT)}=ANY(p.vertical_ids))) AS vertical_ok,
      ${sql.raw(VERT)} AS vertical,
      (${sql.raw(VERT)} IN (SELECT vertical FROM bound_verticals)
        AND EXISTS(SELECT 1 FROM follow_up_sequences s WHERE s.id=i.sequence_id AND s.retired_at IS NULL)) AS sequence_ok,
      b.state AS gstate, b.postal_code AS gzip, b.city AS gcity,
      (SELECT jsonb_agg(jsonb_build_object('id',bl.id,'is_primary',bl.is_primary,'city',bl.city,'state',bl.state,
          'postal_code',bl.postal_code,'county_fips',bl.county_fips) ORDER BY bl.id)
         FROM business_locations bl WHERE bl.business_id=b.id)::text AS glocs,
      obs.outcome AS obs_outcome,
      e.id AS enrollment_found, e.status AS enrollment_status,
      (e.metadata->>'canonicalPreparationId' = i.id::text) AS enrollment_owned,
      (COALESCE(e.metadata,'{}'::jsonb) ? 'canonicalRelease') AS enrollment_released
    FROM cr04_enrollment_intents i
    LEFT JOIN contacts c ON c.id=i.contact_id
    LEFT JOIN businesses b ON b.id=i.business_id
    LEFT JOIN sequence_enrollments e ON e.id=i.enrollment_id
    LEFT JOIN LATERAL (
      SELECT po.outcome FROM provider_observations po
        JOIN provider_operations op ON op.id=po.operation_id AND op.state='completed' AND op.provider='zerobounce'
       WHERE po.subject_type IN ('business','contact') AND po.email_token_hash=i.normalized_email_hash
         AND po.provider='zerobounce' AND po.retryable=FALSE AND po.outcome IN ('valid','invalid')
         AND po.observed_at > now() - (${policy.validationTtlDays}::text||' days')::interval AND po.observed_at <= now()
         AND LEAST(COALESCE(po.expires_at, po.observed_at + (${policy.validationTtlDays}::text||' days')::interval),
                   po.observed_at + (${policy.validationTtlDays}::text||' days')::interval) > now()
       ORDER BY po.observed_at DESC LIMIT 1) obs ON TRUE
    WHERE i.program_id IS NOT NULL AND i.preparation_state IN ('ready_held','pending_validation')`;
  const recorded = rows(await db.execute(recordedQuery));

  const results: Row[] = recorded.map(r => {
    const state = r.state as Row["state"];
    const geo = resolveBusinessCounty({ gstate: r.gstate, gzip: r.gzip, gcity: r.gcity, glocs: r.glocs });
    const county = geo.countyFips;
    let failure: Row["failure"] = null;
    const fail = (gate: LaunchGateKey, code: string) => { failure ??= { gate, code }; };
    if (!r.contact_ok) fail("contact_current", "contact_unavailable");
    else if (!r.address_ok) fail("address_unchanged", "address_changed");
    else if (!r.status_ok) fail("contact_current", "address_marked_undeliverable");
    if (!r.link_ok) fail("business_link_current", "link_not_current");
    if (!r.business_ok) fail("business_current", "business_not_current");
    if (!r.vertical_ok) fail("accepted_vertical", "vertical_not_accepted");
    else if (!r.sequence_ok) fail("sequence_bound", "no_live_sequence");
    if (geo.outcome !== "resolved") fail("in_territory", "location_unresolved");
    else if (!counties.includes(String(county))) fail("in_territory", "outside_territory");
    if (state === "ready_held") {
      if (!r.obs_outcome) fail("fresh_validation", "no_fresh_validation");
      else if (r.obs_outcome !== "valid") fail("fresh_validation", "validation_not_valid");
      if (!r.enrollment_found) fail("paused_membership", "membership_missing");
      else if (r.enrollment_released) fail("paused_membership", "already_released");
      else if (r.enrollment_status !== "paused") fail("paused_membership", "membership_not_paused");
      else if (!r.enrollment_owned) fail("paused_membership", "membership_not_owned");
    }
    return { id: String(r.id), state, contactId: Number(r.contact_id), businessId: Number(r.business_id),
      sequenceId: r.sequence_id === null ? null : Number(r.sequence_id),
      enrollmentId: r.enrollment_id === null ? null : Number(r.enrollment_id),
      failure, county: county ? String(county) : null, vertical: r.vertical ?? null };
  });

  // Consent, hygiene and promotion rules come from the same authority recipient preparation uses.
  const remaining = results.filter(r => !r.failure);
  await mapWithConcurrency(remaining, POLICY_CONCURRENCY, async row => {
    try {
      const decisions = await evaluateContactDecisions(
        { contactId: row.contactId, businessId: row.businessId, channel: "email", mode: "dryRun" });
      const blocked = [decisions.promotion, decisions.dataHygiene, decisions.send]
        .find(d => d && d.status !== "eligible");
      if (blocked) row.failure = { gate: "contact_policy", code: blocked.reasonCodes[0] ?? "CONTACT_POLICY_HOLD" };
    } catch {
      row.failure = { gate: "contact_policy", code: "contact_policy_unreadable" };
    }
  });

  return { results };
}

export async function computeSfpLaunchInventory(): Promise<SfpLaunchInventory> {
  const { results } = await evaluateLaunchRows();
  const summarize = (state: Row["state"]): LaunchInventoryPopulation => {
    const all = results.filter(r => r.state === state);
    const qualified = all.filter(r => !r.failure);
    const byBusiness = new Map<number, number>();
    for (const r of qualified) byBusiness.set(r.businessId, (byBusiness.get(r.businessId) ?? 0) + 1);
    const counts = new Map<string, LaunchReasonCount>();
    for (const r of all) if (r.failure) {
      const key = `${r.failure.gate}|${r.failure.code}`;
      const entry = counts.get(key) ?? { gate: r.failure.gate, code: r.failure.code, label: labelFor(r.failure.code), count: 0 };
      entry.count++; counts.set(key, entry);
    }
    return {
      recorded: all.length, qualified: qualified.length, qualifiedBusinesses: byBusiness.size,
      primaryRecipients: byBusiness.size, alternates: qualified.length - byBusiness.size,
      blocked: [...counts.values()].sort((a, b) => b.count - a.count),
    };
  };

  // County by vertical for qualified businesses (one primary recipient per business).
  const cells = new Map<string, { county: string; vertical: string; businesses: Set<number>; recipients: number }>();
  for (const r of results.filter(x => x.state === "ready_held" && !x.failure)) {
    const key = `${r.county}|${r.vertical}`;
    const cell = cells.get(key) ?? { county: COUNTY_NAMES[String(r.county)] ?? String(r.county), vertical: String(r.vertical),
      businesses: new Set<number>(), recipients: 0 };
    cell.businesses.add(r.businessId); cell.recipients++; cells.set(key, cell);
  }
  const byCountyAndVertical: LaunchCountyVerticalCell[] = [...cells.values()]
    .map(c => ({ county: c.county, vertical: c.vertical, businesses: c.businesses.size, recipients: c.recipients }))
    .sort((a, b) => a.county.localeCompare(b.county) || b.businesses - a.businesses);

  // Sender state, using the one shared definition of a usable identity.
  const identities = rows(await db.execute(sql`SELECT is_active AS "isActive", warmup_status AS "warmupStatus",
    daily_limit AS "dailyLimit", sent_today AS "sentToday" FROM sending_identities`));
  const usable = identities.filter(isUsableSenderIdentity);
  const capacity = usable.reduce((total, i) => total + Number(i.dailyLimit ?? 0), 0);
  const sentToday = usable.reduce((total, i) => total + Number(i.sentToday ?? 0), 0);
  const remainingCapacity = usable.reduce((total, i) => total + remainingDailyCapacity(i), 0);
  const readyPopulation = summarize("ready_held");

  const releaseBlockers: LaunchReleaseBlocker[] = [];
  const lifecycle = decideCr06PromotionalLifecycle({ boundary: "sequence_transport" });
  releaseBlockers.push({
    key: "promotional_execution", label: "Promotional delivery authority",
    state: lifecycle.allowed ? "ok" : "blocked",
    detail: lifecycle.allowed ? "Promotional execution is admitted by the lifecycle authority."
      : "The lifecycle authority refuses all promotional execution, so the sequence worker will not claim a promotional step, except for held recipients an administrator releases through the capped, expiring operator release (up to 50 recipients, 72 hours, revocable).",
  });
  try {
    const { getPauseState } = await import("./outbound-pause-authority");
    const pause = await getPauseState();
    releaseBlockers.push({ key: "outbound_pause", label: "Outbound pause", state: pause.state === "paused" ? "blocked" : "ok",
      detail: pause.state === "paused" ? "Outbound is paused. It stays paused until an operator releases it." : `Outbound pause state: ${pause.state}.` });
  } catch {
    releaseBlockers.push({ key: "outbound_pause", label: "Outbound pause", state: "unknown", detail: "The pause state could not be read." });
  }
  releaseBlockers.push({
    key: "sender_capacity", label: "Sending identity and daily capacity",
    state: usable.length === 0 || remainingCapacity <= 0 ? "blocked" : "ok",
    detail: usable.length === 0
      ? "No sending identity is switched on with a warm or warming state."
      : `${usable.length} usable identit${usable.length === 1 ? "y" : "ies"}; ${remainingCapacity} of ${capacity} messages remain today.`,
  });

  return {
    observedAt: new Date().toISOString(),
    maxAgeSeconds: LAUNCH_INVENTORY_CACHE_SECONDS,
    readyHeld: readyPopulation,
    pendingValidation: summarize("pending_validation"),
    byCountyAndVertical,
    sender: {
      usableIdentities: usable.length, totalIdentities: identities.length, dailyCapacity: capacity, sentToday,
      daysOfFirstTouches: capacity > 0 ? Math.round((readyPopulation.primaryRecipients / capacity) * 10) / 10 : null,
    },
    releaseBlockers,
    notes: [
      "Each recorded recipient is re-checked now against the current rules; the stored state alone is not trusted.",
      "A qualified recipient is not authorized to send. Sending stays held until an operator releases it.",
      "Pending-validation recipients are checked on every rule except validation and membership, which they do not have yet.",
      "One primary recipient per business is counted first; other qualified recipients are kept as alternates.",
    ],
  };
}

let cache: { at: number; value: SfpLaunchInventory } | null = null;
let inflight: Promise<SfpLaunchInventory> | null = null;

export async function readSfpLaunchInventory(opts: { fresh?: boolean } = {}): Promise<SfpLaunchInventory> {
  if (!opts.fresh && cache && Date.now() - cache.at < LAUNCH_INVENTORY_CACHE_SECONDS * 1000) return cache.value;
  if (!inflight) {
    inflight = computeSfpLaunchInventory()
      .then(value => { cache = { at: Date.now(), value }; return value; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

export { LAUNCH_GATE_LABELS };

export interface QualifiedReadyHeldRecipient {
  intentId: string; enrollmentId: number; contactId: number; businessId: number; sequenceId: number;
  county: string | null; vertical: string | null;
}

/**
 * Ready-held recipients that pass every launch requirement right now, one primary recipient per
 * business (lowest enrollment id, so the choice is stable between preview and execute).
 */
export async function listQualifiedPrimaryRecipients(): Promise<QualifiedReadyHeldRecipient[]> {
  const { results } = await evaluateLaunchRows();
  const byBusiness = new Map<number, Row>();
  for (const r of results) {
    if (r.state !== "ready_held" || r.failure || r.enrollmentId === null || r.sequenceId === null) continue;
    const current = byBusiness.get(r.businessId);
    if (!current || r.enrollmentId < current.enrollmentId!) byBusiness.set(r.businessId, r);
  }
  return [...byBusiness.values()]
    .sort((a, b) => a.enrollmentId! - b.enrollmentId!)
    .map(r => ({ intentId: r.id, enrollmentId: r.enrollmentId!, contactId: r.contactId, businessId: r.businessId,
      sequenceId: r.sequenceId!, county: r.county ? (COUNTY_NAMES[r.county] ?? r.county) : null, vertical: r.vertical }));
}
