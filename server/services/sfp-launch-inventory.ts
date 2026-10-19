import { createHash } from "node:crypto";
import { sfpLaunchPresentationFingerprint } from "./cro03/sfp-launch-presentation";
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
import { preparedFactsCurrentSql } from "./canonical-recipient-preparation";
import { decideCr06PromotionalLifecycle } from "./cr06-promotional-lifecycle-decision";
import { isUsableSenderIdentity } from "./sdr/sender-identity-state";
import { readSenderCapacity } from "./sfp-sender-capacity";

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
  package_content_changed: "The package content changed after this recipient was prepared; the normal preparation pass will refresh it",
  prepared_facts_stale: "The recipient's recorded facts no longer match current records; the normal preparation pass will refresh them",
  binding_changed: "The approved recipient, address, business, sequence or package changed since release",
};
const labelFor = (code: string) => CODE_LABELS[code]
  ?? (code.charAt(0).toUpperCase() + code.slice(1).toLowerCase().replace(/[_-]+/g, " "));

interface Row {
  id: string; state: "ready_held" | "pending_validation"; contactId: number; businessId: number;
  sequenceId: number | null; enrollmentId: number | null;
  failure: { gate: LaunchGateKey; code: string } | null;
  county: string | null; vertical: string | null;
  kind: "new" | "continuation"; currentStep: number; emailHash: string;
  binding: RecipientBinding; bindingHash: string; evidence: RecipientEvidence;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; out[index] = await fn(items[index]); }
  }));
  return out;
}

/** What an administrator approves for one recipient. Recomputed from live facts at release and at every dispatch. */
export interface RecipientBinding {
  intentId: string; contactId: number; emailHash: string; emailGeneration: number | null;
  businessId: number; programId: string | null; sequenceId: number | null; vertical: string | null; county: string | null;
  packageVersionId: string | null; contentHash: string | null; policyVersion: string | null; businessFingerprint: string | null;
}
/** Evidence recorded next to the binding but deliberately not part of its hash (it can change benignly). */
export interface RecipientEvidence { validationOperationId: string | null; linkDecisionId: string | null }

export function computeBindingHash(binding: RecipientBinding): string {
  const b = binding;
  return createHash("sha256").update(JSON.stringify([
    b.intentId, b.contactId, b.emailHash, b.emailGeneration, b.businessId, b.programId, b.sequenceId, b.vertical,
    b.county, b.packageVersionId, b.contentHash, b.policyVersion, b.businessFingerprint,
    // Rendered presentation is part of what the administrator approves; a change invalidates approvals and held releases.
    sfpLaunchPresentationFingerprint()])).digest("hex");
}

/** Reasons a held, ended journey may be continued by an explicit new release. Revoked journeys are not listed. */
export const CONTINUABLE_ENDED_REASONS = ["journey_expired", "package_content_changed", "validation_not_current"] as const;

/** Applies the shared contact/promotion/hygiene/send decision to one row that passed every recorded-fact gate. */
async function applyContactPolicy(row: Row): Promise<void> {
  try {
    const decisions = await evaluateContactDecisions(
      { contactId: row.contactId, businessId: row.businessId, channel: "email", mode: "dryRun" });
    const blocked = [decisions.promotion, decisions.dataHygiene, decisions.send]
      .find(d => d && d.status !== "eligible");
    if (blocked) row.failure = { gate: "contact_policy", code: blocked.reasonCodes[0] ?? "CONTACT_POLICY_HOLD" };
  } catch {
    row.failure = { gate: "contact_policy", code: "contact_policy_unreadable" };
  }
}

async function evaluateLaunchRows(
  opts: { intentIds?: string[]; mode?: "release" | "dispatch"; deferPolicy?: boolean } = {},
): Promise<{ results: Row[] }> {
  const mode = opts.mode ?? "release";
  const policy = await getActiveSfpOutreachPolicy({ bypassCache: true });
  const VERT = effectiveBusinessVerticalSql("b");
  const STATUS = effectiveBusinessVerticalStatusSql("b");
  const intentFilter = opts.intentIds
    ? sql`AND i.id IN (${sql.join(opts.intentIds.map(id => sql`${id}::uuid`), sql`,`)})` : sql``;

  const recordedQuery = sql`
    WITH ${boundVerticalsCte()}
    SELECT i.id::text AS id, i.preparation_state AS state, i.contact_id, i.business_id, i.sequence_id, i.enrollment_id,
      i.normalized_email_hash AS email_hash, i.program_id::text AS program_id, i.preparation_snapshot AS snapshot,
      c.email_mutation_generation AS email_generation, p.county_fips AS program_counties,
      COALESCE((${sql.raw(preparedFactsCurrentSql())}), FALSE) AS facts_ok,
      (SELECT pkg.content_hash FROM sfp_campaign_package_versions pkg
        WHERE pkg.sequence_id=i.sequence_id AND pkg.lifecycle_state='current' ORDER BY pkg.id LIMIT 1) AS current_content_hash,
      (SELECT d.id::text FROM contact_business_link_decisions d
        WHERE d.contact_id=i.contact_id AND d.business_id=i.business_id AND d.decision='verified' AND d.superseded_at IS NULL
        ORDER BY d.id DESC LIMIT 1) AS link_decision_id,
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
      obs.outcome AS obs_outcome, obs.operation_id::text AS obs_operation_id,
      e.id AS enrollment_found, e.status AS enrollment_status, e.current_step AS enrollment_step,
      (e.metadata->>'canonicalPreparationId' = i.id::text) AS enrollment_owned,
      (COALESCE(e.metadata,'{}'::jsonb) ? 'canonicalRelease') AS enrollment_released,
      e.metadata->'canonicalRelease'->>'endedReason' AS ended_reason
    FROM cr04_enrollment_intents i
    LEFT JOIN contacts c ON c.id=i.contact_id
    LEFT JOIN businesses b ON b.id=i.business_id
    LEFT JOIN sfp_programs p ON p.id=i.program_id
    LEFT JOIN follow_up_sequences seq ON seq.id=i.sequence_id
    LEFT JOIN sequence_enrollments e ON e.id=i.enrollment_id
    LEFT JOIN LATERAL (
      SELECT po.outcome, po.operation_id FROM provider_observations po
        JOIN provider_operations op ON op.id=po.operation_id AND op.state='completed' AND op.provider='zerobounce'
       WHERE po.subject_type IN ('business','contact') AND po.email_token_hash=i.normalized_email_hash
         AND po.provider='zerobounce' AND po.retryable=FALSE AND po.outcome IN ('valid','invalid')
         AND po.observed_at > now() - (${policy.validationTtlDays}::text||' days')::interval AND po.observed_at <= now()
         AND LEAST(COALESCE(po.expires_at, po.observed_at + (${policy.validationTtlDays}::text||' days')::interval),
                   po.observed_at + (${policy.validationTtlDays}::text||' days')::interval) > now()
       ORDER BY po.observed_at DESC LIMIT 1) obs ON TRUE
    WHERE i.program_id IS NOT NULL AND i.preparation_state IN ('ready_held','pending_validation') ${intentFilter}`;
  const recorded = rows(await db.execute(recordedQuery));

  const results: Row[] = recorded.map(r => {
    const state = r.state as Row["state"];
    const geo = resolveBusinessCounty({ gstate: r.gstate, gzip: r.gzip, gcity: r.gcity, glocs: r.glocs });
    const county = geo.countyFips;
    const counties: string[] = (r.program_counties ?? []).map(String);
    const snapshot = (r.snapshot && typeof r.snapshot === "object" ? r.snapshot : {}) as Record<string, any>;
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
    // The recorded preparation must still describe today's facts, including the package pin. A stale pin is
    // refreshed by the ordinary preparation worker; until then the recipient is not releasable.
    const packageChanged = !!snapshot.contentHash && !!r.current_content_hash && snapshot.contentHash !== r.current_content_hash;
    if (!r.facts_ok) fail("prepared_facts_current", packageChanged ? "package_content_changed" : "prepared_facts_stale");
    let kind: Row["kind"] = "new";
    const step = r.enrollment_step == null ? 0 : Number(r.enrollment_step);
    if (state === "ready_held") {
      if (!r.obs_outcome) fail("fresh_validation", "no_fresh_validation");
      else if (r.obs_outcome !== "valid") fail("fresh_validation", "validation_not_valid");
      if (mode === "release") {
        if (!r.enrollment_found) fail("paused_membership", "membership_missing");
        else if (r.enrollment_released) {
          // A journey held for a reason that is not the recipient's fault may be released again by an explicit new
          // release: mid-journey it continues at the next touch; never sent, it is released like a new recipient.
          const continuable = r.enrollment_status === "paused"
            && (CONTINUABLE_ENDED_REASONS as readonly string[]).includes(String(r.ended_reason ?? ""));
          if (continuable) kind = step > 0 ? "continuation" : "new"; else fail("paused_membership", "already_released");
        }
        else if (r.enrollment_status !== "paused") fail("paused_membership", "membership_not_paused");
        else if (!r.enrollment_owned) fail("paused_membership", "membership_not_owned");
      }
    }
    const binding: RecipientBinding = {
      intentId: String(r.id), contactId: Number(r.contact_id), emailHash: String(r.email_hash),
      emailGeneration: r.email_generation == null ? null : Number(r.email_generation),
      businessId: Number(r.business_id), programId: r.program_id ? String(r.program_id) : null,
      sequenceId: r.sequence_id === null ? null : Number(r.sequence_id), vertical: r.vertical ?? null,
      county: county ? String(county) : null,
      packageVersionId: snapshot.packageVersionId ?? null, contentHash: snapshot.contentHash ?? null,
      policyVersion: snapshot.policyVersion == null ? null : String(snapshot.policyVersion),
      businessFingerprint: snapshot.businessSourceFingerprint ?? null,
    };
    return { id: String(r.id), state, contactId: Number(r.contact_id), businessId: Number(r.business_id),
      sequenceId: r.sequence_id === null ? null : Number(r.sequence_id),
      enrollmentId: r.enrollment_id === null ? null : Number(r.enrollment_id),
      failure, county: county ? String(county) : null, vertical: r.vertical ?? null,
      kind, currentStep: step, emailHash: String(r.email_hash), binding, bindingHash: computeBindingHash(binding),
      evidence: { validationOperationId: r.obs_operation_id ?? null, linkDecisionId: r.link_decision_id ?? null } };
  });

  // Consent, hygiene and promotion rules come from the same authority recipient preparation uses. Evaluating them
  // costs a few hundred milliseconds per recipient, so callers that only need the first N recipients defer it and
  // apply it row by row (`applyContactPolicy`); the full inventory count still evaluates every remaining row.
  if (!opts.deferPolicy) {
    await mapWithConcurrency(results.filter(r => !r.failure), POLICY_CONCURRENCY, applyContactPolicy);
  }

  return { results };
}

/**
 * Re-derives one prepared recipient's binding from live facts. Used inside release execution and at final
 * dispatch authorization. `ok` is false when any launch requirement fails or the binding no longer matches.
 */
export async function verifyRecipientBinding(
  intentId: string, expectedBindingHash: string,
): Promise<{ ok: boolean; reason: string | null; bindingHash: string | null; binding: RecipientBinding | null; evidence: RecipientEvidence | null }> {
  const { results } = await evaluateLaunchRows({ intentIds: [intentId], mode: "dispatch" });
  const row = results[0];
  if (!row) return { ok: false, reason: "prepared_facts_stale", bindingHash: null, binding: null, evidence: null };
  if (row.failure) return { ok: false, reason: row.failure.code, bindingHash: row.bindingHash, binding: row.binding, evidence: row.evidence };
  if (row.bindingHash !== expectedBindingHash) {
    return { ok: false, reason: "binding_changed", bindingHash: row.bindingHash, binding: row.binding, evidence: row.evidence };
  }
  return { ok: true, reason: null, bindingHash: row.bindingHash, binding: row.binding, evidence: row.evidence };
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

  // Sender state: the same capacity definition preview, release execution and dispatch reserve against.
  const identities = rows(await db.execute(sql`SELECT is_active AS "isActive", warmup_status AS "warmupStatus",
    daily_limit AS "dailyLimit", sent_today AS "sentToday" FROM sending_identities`));
  const usable = identities.filter(isUsableSenderIdentity);
  const senderCapacity = await readSenderCapacity();
  const capacity = senderCapacity.identityLimit;
  const sentToday = senderCapacity.identityUsedElsewhere + senderCapacity.identityUsedByLaunch;
  const remainingCapacity = senderCapacity.remaining;
  const readyPopulation = summarize("ready_held");

  const releaseBlockers: LaunchReleaseBlocker[] = [];
  const lifecycle = decideCr06PromotionalLifecycle({ boundary: "sequence_transport" });
  releaseBlockers.push({
    key: "promotional_execution", label: "Promotional delivery authority",
    state: lifecycle.allowed ? "ok" : "blocked",
    detail: lifecycle.allowed ? "Promotional execution is admitted by the lifecycle authority."
      : "The lifecycle authority refuses all promotional execution, so the sequence worker will not claim a promotional step, except for held recipients an administrator releases through the operator release (bounded by policy and actual sender capacity, a finite admission window and journey period, revocable).",
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
    state: !senderCapacity.sender?.usable || remainingCapacity <= 0 ? "blocked" : "ok",
    detail: !senderCapacity.sender
      ? "The selected sending address has no sending identity."
      : !senderCapacity.sender.usable
        ? "The selected sending identity is not switched on with a warm or warming state."
        : `${senderCapacity.sender.emailAddress}: ${senderCapacity.identityRemaining} of ${capacity} remain today for the sender; global cold ceiling leaves ${senderCapacity.globalRemaining} of ${senderCapacity.globalCeiling}; ${senderCapacity.committedNext24h} already-released messages are due within 24 hours; ${remainingCapacity} can still be admitted.`,
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
  kind: "new" | "continuation"; currentStep: number; emailHash: string;
  binding: RecipientBinding; bindingHash: string; evidence: RecipientEvidence;
}

/**
 * Recipients that pass every launch requirement right now (including the package pin and current facts).
 * Continuations of ended journeys come first, then new recipients. At most one recipient per business and
 * one per normalized address; a business or address that already has a journey in flight is skipped. Distinct
 * businesses and people are never merged: the others simply stay held.
 */
export async function listQualifiedPrimaryRecipients(
  opts: { limit?: number; accept?: (row: { sequenceId: number }) => Promise<boolean> | boolean } = {},
): Promise<QualifiedReadyHeldRecipient[]> {
  return (await selectPrimaryRecipients(opts)).chosen;
}

/**
 * With a limit or an accept filter the shared contact policy is applied only to the recipients actually considered
 * for selection (in order), not to every candidate, so selection cost follows the release size rather than the
 * whole prepared population. `primaryCandidates` counts distinct primary recipients that pass every recorded-fact
 * gate before that policy check.
 */
export async function selectPrimaryRecipients(
  opts: { limit?: number; accept?: (row: { sequenceId: number }) => Promise<boolean> | boolean } = {},
): Promise<{ chosen: QualifiedReadyHeldRecipient[]; primaryCandidates: number }> {
  const lazy = opts.limit !== undefined || opts.accept !== undefined;
  const { results } = await evaluateLaunchRows({ deferPolicy: lazy });
  const inFlight = rows(await db.execute(sql`
    SELECT i.business_id, i.normalized_email_hash AS email_hash
      FROM sequence_enrollments e JOIN cr04_enrollment_intents i ON i.id::text=e.metadata->>'canonicalPreparationId'
     WHERE e.status='active' AND COALESCE(e.metadata,'{}'::jsonb) ? 'canonicalRelease'`));
  const busyBusinesses = new Set(inFlight.map(r => Number(r.business_id)));
  const busyAddresses = new Set(inFlight.map(r => String(r.email_hash)));
  const candidates = results
    .filter(r => r.state === "ready_held" && !r.failure && r.enrollmentId !== null && r.sequenceId !== null)
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "continuation" ? -1 : 1) || a.enrollmentId! - b.enrollmentId!);
  const businesses = new Set<number>(busyBusinesses);
  const addresses = new Set<string>(busyAddresses);
  const chosen: Row[] = [];
  const accepted = new Map<number, boolean>();
  const seenBusinesses = new Set<number>(busyBusinesses), seenAddresses = new Set<string>(busyAddresses);
  let primaryCandidates = 0;
  for (const r of candidates) {
    if (seenBusinesses.has(r.businessId) || seenAddresses.has(r.emailHash)) continue;
    seenBusinesses.add(r.businessId); seenAddresses.add(r.emailHash); primaryCandidates++;
  }
  for (const r of candidates) {
    if (opts.limit !== undefined && chosen.length >= opts.limit) break;
    if (businesses.has(r.businessId) || addresses.has(r.emailHash)) continue;
    if (opts.accept) {
      if (!accepted.has(r.sequenceId!)) accepted.set(r.sequenceId!, await opts.accept({ sequenceId: r.sequenceId! }));
      if (!accepted.get(r.sequenceId!)) continue;
    }
    // A recipient the shared policy refuses must not consume its business or address: an alternate may still qualify.
    if (lazy) { await applyContactPolicy(r); if (r.failure) continue; }
    businesses.add(r.businessId); addresses.add(r.emailHash); chosen.push(r);
  }
  return { primaryCandidates, chosen: chosen.map(r => ({ intentId: r.id, enrollmentId: r.enrollmentId!, contactId: r.contactId,
    businessId: r.businessId, sequenceId: r.sequenceId!, county: r.county ? (COUNTY_NAMES[r.county] ?? r.county) : null,
    vertical: r.vertical, kind: r.kind, currentStep: r.currentStep, emailHash: r.emailHash, binding: r.binding,
    bindingHash: r.bindingHash, evidence: r.evidence })) };
}
