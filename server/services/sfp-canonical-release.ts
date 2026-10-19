/**
 * Narrow release authority for current canonical SFP recipients.
 *
 * Promotional sequence execution stays refused by the lifecycle authority. This module is the one
 * explicit, operator-driven exception. A release has TWO separate, finite periods:
 *
 *   admission window   how long an administrator's release may still START first touches
 *   journey deadline   how long each admitted recipient may complete the approved touch schedule
 *
 * Separating them lets a short admission window coexist with a multi-day sequence (touches 2 and 3 are
 * due days after the first send) without extending anyone's approval open-endedly. Revocation, suppression,
 * pauses and changed recipient/content facts stay effective throughout.
 *
 * A released enrollment is bound to the exact recipient and content that were approved (contact, normalized
 * address and mutation generation, business, program, vertical, county, sequence, package version and content
 * hash, policy version). The binding is rechecked inside release execution and again at final dispatch
 * authorization; nothing is cached across expiry, revocation or changed facts.
 *
 * Nothing here sends. A released enrollment still has to clear the outbound pause, the coordinator, reply-stop,
 * consent, suppression, validation, sender policy, actual sender capacity and the dispatch authority in the
 * sequence worker. Releasing does not lift the outbound pause.
 */
import { createHash, randomUUID } from "node:crypto";
import { pool } from "../db";
import {
  selectPrimaryRecipients, verifyRecipientBinding, CONTINUABLE_ENDED_REASONS,
  type QualifiedReadyHeldRecipient, type RecipientBinding,
} from "./sfp-launch-inventory";
import { preparedFactsCurrentSql } from "./canonical-recipient-preparation";
import { readSenderCapacity, type SenderCapacity } from "./sfp-sender-capacity";

export const CANONICAL_RELEASE_CONTROL_KEY = "sfp_canonical_release_control";
export const CANONICAL_RELEASE_POLICY_KEY = "sfp_canonical_release_policy";
const LOCK_KEY = "sfp-canonical-release";
const LEDGER_RETENTION_MS = 60 * 86_400_000;

// ── Admission policy ─────────────────────────────────────────────────────────
export interface CanonicalReleasePolicy {
  /** Largest release an administrator may request. Actual size is also bounded by real sender capacity. */
  maxRecipientsPerRelease: number;
  /** Longest period a release may keep admitting first touches. */
  maxAdmissionWindowHours: number;
  /** Finite period in which an admitted recipient may complete the approved touch schedule. */
  journeyDays: number;
}
export const DEFAULT_RELEASE_POLICY: CanonicalReleasePolicy = { maxRecipientsPerRelease: 500, maxAdmissionWindowHours: 72, journeyDays: 14 };
export const RELEASE_POLICY_BOUNDS = {
  maxRecipientsPerRelease: { min: 1, max: 5000 }, maxAdmissionWindowHours: { min: 1, max: 168 }, journeyDays: { min: 4, max: 30 },
} as const;

// Compatibility exports for callers that display the limits.
export const CANONICAL_RELEASE_MAX_SIZE = DEFAULT_RELEASE_POLICY.maxRecipientsPerRelease;
export const CANONICAL_RELEASE_MAX_HOURS = DEFAULT_RELEASE_POLICY.maxAdmissionWindowHours;

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class CanonicalReleaseError extends Error {
  constructor(public readonly code: string, public readonly status = 409, message?: string) {
    super(message ?? code);
  }
}

export function validateReleasePolicy(input: unknown): CanonicalReleasePolicy {
  const value = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_RELEASE_POLICY };
  for (const key of Object.keys(RELEASE_POLICY_BOUNDS) as Array<keyof typeof RELEASE_POLICY_BOUNDS>) {
    if (value[key] === undefined) continue;
    const n = Number(value[key]); const b = RELEASE_POLICY_BOUNDS[key];
    if (!Number.isInteger(n) || n < b.min || n > b.max) {
      throw new CanonicalReleaseError("RELEASE_POLICY_INVALID", 400, `${key} must be a whole number from ${b.min} to ${b.max}`);
    }
    out[key] = n;
  }
  return out;
}

export async function readReleasePolicy(): Promise<CanonicalReleasePolicy> {
  const r = await pool.query(`SELECT value FROM system_settings WHERE key=$1`, [CANONICAL_RELEASE_POLICY_KEY]);
  try { return validateReleasePolicy(r.rows[0]?.value); } catch { return { ...DEFAULT_RELEASE_POLICY }; }
}

export async function writeReleasePolicy(input: unknown, actorId: string): Promise<CanonicalReleasePolicy> {
  const policy = validateReleasePolicy({ ...(await readReleasePolicy()), ...(input as object) });
  await pool.query(
    `INSERT INTO system_settings(key,value,updated_at) VALUES($1,$2::jsonb,NOW())
     ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
    [CANONICAL_RELEASE_POLICY_KEY, JSON.stringify({ ...policy, updatedBy: actorId })]);
  return policy;
}

// ── Release ledger ───────────────────────────────────────────────────────────
export interface ReleaseRecord {
  releaseId: string;
  commandKeyHash: string;
  snapshotHash: string;
  enrollmentIds: number[];
  releasedBy: string; releasedAt: string;
  admissionClosesAt: string;
  journeyExpiresAt: string;
  admissionClosedAt: string | null;
  journeyEndedAt: string | null;
  revokedBy: string | null; revokedAt: string | null;
}
export interface CanonicalReleaseControl { releases: ReleaseRecord[] }

function parseControl(value: unknown): CanonicalReleaseControl {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, any>;
  if (Array.isArray(v.releases)) return { releases: v.releases as ReleaseRecord[] };
  // Legacy single-release shape: one hard expiry for both periods; behaves exactly as before.
  if (typeof v.releaseId === "string" && v.releaseId) {
    const revoked = v.enabled !== true;
    return { releases: [{
      releaseId: v.releaseId, commandKeyHash: v.commandKeyHash ?? "", snapshotHash: v.snapshotHash ?? "",
      enrollmentIds: Array.isArray(v.enrollmentIds) ? v.enrollmentIds : [], releasedBy: v.releasedBy ?? "", releasedAt: v.releasedAt ?? "",
      admissionClosesAt: v.expiresAt, journeyExpiresAt: v.expiresAt, admissionClosedAt: null, journeyEndedAt: null,
      revokedBy: revoked ? (v.revokedBy ?? "legacy") : null, revokedAt: revoked ? (v.revokedAt ?? v.expiresAt) : null,
    }] };
  }
  return { releases: [] };
}

const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);
export const admissionOpen = (r: ReleaseRecord, now: Date) => !r.revokedAt && ms(r.admissionClosesAt) > now.getTime();
export const journeyLive = (r: ReleaseRecord, now: Date) => !r.revokedAt && ms(r.journeyExpiresAt) > now.getTime();

export async function readCanonicalReleaseControl(): Promise<CanonicalReleaseControl> {
  const r = await pool.query(`SELECT value FROM system_settings WHERE key=$1`, [CANONICAL_RELEASE_CONTROL_KEY]);
  return parseControl(r.rows[0]?.value);
}

/** True while any release can still admit a first touch or carry a started journey. */
export function controlHasLiveAuthority(control: CanonicalReleaseControl, now: Date = new Date()): boolean {
  return control.releases.some(r => journeyLive(r, now));
}
/** Compatibility name used by callers that only need "is anything live". */
export const isControlLive = controlHasLiveAuthority;

export async function hasLiveCanonicalReleaseAuthority(now: Date = new Date()): Promise<boolean> {
  return controlHasLiveAuthority(await readCanonicalReleaseControl(), now);
}

async function writeControl(client: { query: (q: string, p?: unknown[]) => Promise<any> }, control: CanonicalReleaseControl, now: Date) {
  const kept = control.releases.filter(r => ms(r.journeyExpiresAt) + LEDGER_RETENTION_MS > now.getTime() || !r.journeyEndedAt);
  await client.query(
    `INSERT INTO system_settings(key,value,updated_at) VALUES($1,$2::jsonb,NOW())
     ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
    [CANONICAL_RELEASE_CONTROL_KEY, JSON.stringify({ releases: kept })]);
}

// ── Authority evaluation (used by the worker at claim time and again at final dispatch) ──
export interface CanonicalAuthority {
  admitted: boolean;
  reason: string | null;
  releaseId: string | null;
  /** How the enrollment must be settled when authority is denied. */
  settle: "none" | "unmark" | "end";
  endedReason: string | null;
}
const DENY = (reason: string, releaseId: string | null, settle: CanonicalAuthority["settle"] = "none", endedReason: string | null = null): CanonicalAuthority =>
  ({ admitted: false, reason, releaseId, settle, endedReason });

const BINDING_END_REASON: Record<string, string> = {
  package_content_changed: "package_content_changed",
  no_fresh_validation: "validation_not_current", validation_not_valid: "validation_not_current",
  binding_changed: "binding_changed",
};

/**
 * Fresh, uncached decision. Fails closed on any read error, missing marker, unknown/revoked/expired release,
 * closed admission window for an unsent first touch, a non-canonical sequence or (when asked) changed facts.
 */
export async function evaluateCanonicalAuthority(
  enrollment: { id: number; status?: string | null; currentStep?: number | null; metadata?: unknown },
  sequence: { retiredAt?: unknown; triggerConfig?: unknown },
  opts: { verifyFacts?: boolean; now?: Date } = {},
): Promise<CanonicalAuthority> {
  const now = opts.now ?? new Date();
  try {
    if (sequence.retiredAt) return DENY("SEQUENCE_RETIRED", null);
    const trigger = (sequence.triggerConfig && typeof sequence.triggerConfig === "object" ? sequence.triggerConfig : {}) as Record<string, unknown>;
    if (typeof trigger.canonicalProgramId !== "string" || !trigger.canonicalProgramId) return DENY("NOT_CANONICAL_SEQUENCE", null);
    const meta = (enrollment.metadata && typeof enrollment.metadata === "object" ? enrollment.metadata : {}) as Record<string, any>;
    const marker = meta.canonicalRelease;
    if (!marker || typeof marker.releaseId !== "string" || typeof meta.canonicalPreparationId !== "string") return DENY("NO_RELEASE_MARKER", null);
    if (marker.endedReason) return DENY("JOURNEY_ENDED", marker.releaseId);
    const control = await readCanonicalReleaseControl();
    const release = control.releases.find(r => r.releaseId === marker.releaseId);
    if (!release) return DENY("RELEASE_NOT_FOUND", marker.releaseId);
    if (!release.enrollmentIds.includes(enrollment.id)) return DENY("NOT_IN_RELEASE", marker.releaseId);
    if (release.revokedAt) return DENY("RELEASE_REVOKED", release.releaseId, "end", "revoked");
    if (!(ms(release.journeyExpiresAt) > now.getTime())) return DENY("JOURNEY_EXPIRED", release.releaseId, "end", "journey_expired");
    const step = Number(enrollment.currentStep ?? 0);
    if (step === 0 && !(ms(release.admissionClosesAt) > now.getTime())) {
      const started = await pool.query(
        `SELECT 1 FROM outbound_send_log WHERE sequence_enrollment_id=$1
            AND status IN ('sent','dispatching','delivered','bounced','complained') LIMIT 1`, [enrollment.id]);
      if (started.rows.length === 0) return DENY("ADMISSION_WINDOW_CLOSED", release.releaseId, "unmark");
    }
    if (opts.verifyFacts) {
      if (typeof marker.bindingHash !== "string" || !marker.binding?.intentId) return DENY("BINDING_MISSING", release.releaseId, "end", "binding_changed");
      const dup = await pool.query(
        `SELECT 1 FROM sequence_enrollments e2 JOIN cr04_enrollment_intents i2 ON i2.id::text=e2.metadata->>'canonicalPreparationId'
          WHERE e2.id<>$1 AND e2.id<$1 AND e2.status='active' AND COALESCE(e2.metadata,'{}'::jsonb) ? 'canonicalRelease'
            AND (i2.normalized_email_hash=$2 OR i2.business_id=$3) LIMIT 1`,
        [enrollment.id, marker.binding.emailHash, marker.binding.businessId]);
      if (dup.rows.length > 0) return DENY("duplicate_journey_for_address_or_business", release.releaseId, "end", "duplicate_journey");
      if (String(meta.canonicalPreparationId) !== String(marker.binding.intentId)) return DENY("binding_changed", release.releaseId, "end", "binding_changed");
      const check = await verifyRecipientBinding(marker.binding.intentId, marker.bindingHash);
      if (!check.ok) {
        const reason = check.reason ?? "binding_changed";
        return DENY(reason, release.releaseId, "end", BINDING_END_REASON[reason] ?? "recipient_facts_changed");
      }
    }
    return { admitted: true, reason: null, releaseId: release.releaseId, settle: "none", endedReason: null };
  } catch {
    return DENY("AUTHORITY_UNREADABLE", null);
  }
}

/** Boolean form for callers that only need "may this enrollment be processed at all" (claim boundary). */
export async function isCanonicalReleaseAdmitted(
  enrollment: { id: number; status?: string | null; currentStep?: number | null; metadata?: unknown },
  sequence: { retiredAt?: unknown; triggerConfig?: unknown },
): Promise<boolean> {
  return (await evaluateCanonicalAuthority(enrollment, sequence)).admitted;
}

/**
 * Applies a denial to the enrollment. `unmark` returns an unsent first touch to the held pool; `end` pauses the
 * journey in place (current step, ownership and send receipts are preserved) with an explicit reason.
 */
export async function settleCanonicalEnrollment(
  enrollmentId: number, releaseId: string | null, authority: Pick<CanonicalAuthority, "settle" | "endedReason">,
  now: Date = new Date(),
): Promise<boolean> {
  if (authority.settle === "none") return false;
  const releaseFilter = releaseId ? `AND metadata->'canonicalRelease'->>'releaseId'=$2` : "";
  const params: unknown[] = releaseId ? [enrollmentId, releaseId] : [enrollmentId];
  if (authority.settle === "unmark") {
    const r = await pool.query(
      `UPDATE sequence_enrollments SET status='paused', next_action_at=NULL, updated_at=NOW(),
              metadata=(COALESCE(metadata,'{}'::jsonb) - 'canonicalRelease') || '{"outboundAuthorized":false}'::jsonb
        WHERE id=$1 AND status='active' AND current_step=0 ${releaseFilter}
          AND NOT EXISTS (SELECT 1 FROM outbound_send_log l WHERE l.sequence_enrollment_id=sequence_enrollments.id
                            AND l.status IN ('sent','dispatching','delivered','bounced','complained'))`, params);
    return (r.rowCount ?? 0) > 0;
  }
  const r = await pool.query(
    `UPDATE sequence_enrollments SET status='paused', next_action_at=NULL, updated_at=NOW(),
            metadata=COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('outboundAuthorized',false,'canonicalRelease',
              COALESCE(metadata->'canonicalRelease','{}'::jsonb) || jsonb_build_object('endedReason',$${params.length + 1}::text,'endedAt',$${params.length + 2}::text))
      WHERE id=$1 AND status='active' ${releaseFilter}`,
    [...params, authority.endedReason ?? "ended", now.toISOString()]);
  return (r.rowCount ?? 0) > 0;
}

// ── Preview ──────────────────────────────────────────────────────────────────
export interface CanonicalReleasePreview {
  snapshotHash: string;
  size: number;
  requestedLimit: number;
  dailyCapacityRemaining: number;
  qualifiedPrimaryRecipients: number;
  continuations: number;
  recipients: Array<Pick<QualifiedReadyHeldRecipient, "enrollmentId" | "businessId" | "county" | "vertical" | "sequenceId" | "kind" | "currentStep">
    & { bindingHash: string }>;
  policy: CanonicalReleasePolicy;
  capacity: SenderCapacity | null;
  releases: ReleaseRecord[];
  notes: string[];
}

/** Test seam: the recipient and capacity readers. Production always uses the real ones. */
export interface CanonicalReleaseDeps {
  listQualified: () => Promise<QualifiedReadyHeldRecipient[]>;
  capacity: () => Promise<number>;
}

/** True only when the sequence has real, renderable email steps (and, for a pinned package, a matching campaign). */
export async function sequenceHasLaunchReadyContent(sequenceId: number): Promise<boolean> {
  const steps = await pool.query(
    `SELECT action_type, subject, body FROM sequence_steps WHERE sequence_id=$1 ORDER BY step_order`, [sequenceId]);
  if (steps.rows.length === 0) return false;
  if (steps.rows.some(r => r.action_type !== "email" || !String(r.subject ?? "").trim() || !String(r.body ?? "").trim())) return false;
  const pkg = await pool.query(
    `SELECT campaign_id FROM sfp_campaign_package_versions WHERE sequence_id=$1 AND lifecycle_state='current' LIMIT 1`, [sequenceId]);
  if (pkg.rows.length === 0) return true;
  const { checkPackageContentReadiness } = await import("./cro03/sfp-launch-content");
  const { db } = await import("../db");
  return (await checkPackageContentReadiness(db, Number(pkg.rows[0].campaign_id), sequenceId)).ok;
}

async function scheduleDays(sequenceId: number): Promise<number> {
  const r = await pool.query(
    `SELECT COALESCE(SUM(delay_days),0)::int AS d, COALESCE(SUM(delay_hours),0)::int AS h FROM sequence_steps WHERE sequence_id=$1`, [sequenceId]);
  return Number(r.rows[0]?.d ?? 0) + Math.ceil(Number(r.rows[0]?.h ?? 0) / 24);
}

async function selectForRelease(requestedLimit: number, deps?: CanonicalReleaseDeps) {
  const policy = await readReleasePolicy();
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > policy.maxRecipientsPerRelease) {
    throw new CanonicalReleaseError("RELEASE_LIMIT_INVALID", 400, `limit must be 1-${policy.maxRecipientsPerRelease}`);
  }
  const capacityDetail = deps ? null : await readSenderCapacity();
  const capacity = deps ? await deps.capacity() : capacityDetail!.remaining;
  if (deps) {
    const allQualified = await deps.listQualified();
    // A sequence with no launch-ready steps must never be released: the worker would otherwise
    // have nothing to send and nothing truthful to record. Checked once per distinct sequence.
    const readyBySequence = new Map<number, boolean>();
    for (const sequenceId of new Set(allQualified.map(r => r.sequenceId))) {
      readyBySequence.set(sequenceId, await sequenceHasLaunchReadyContent(sequenceId));
    }
    const qualified = allQualified.filter(r => readyBySequence.get(r.sequenceId) === true);
    const size = Math.min(requestedLimit, capacity, qualified.length);
    return { policy, qualified: qualified.length, capacity, capacityDetail, chosen: qualified.slice(0, size) };
  }
  // Production path: the shared contact policy is evaluated only for the recipients considered for this release
  // (in order), so preview and execute cost follows the release size, not the whole prepared population.
  // A sequence with no launch-ready content is skipped here (once per distinct sequence).
  const picked = await selectPrimaryRecipients({
    limit: Math.min(requestedLimit, capacity),
    accept: r => sequenceHasLaunchReadyContent(r.sequenceId),
  });
  return { policy, qualified: picked.primaryCandidates, capacity, capacityDetail, chosen: picked.chosen };
}

const snapshotOf = (chosen: QualifiedReadyHeldRecipient[], requestedLimit: number) =>
  sha({ items: chosen.map(c => [c.enrollmentId, c.intentId, c.sequenceId, c.kind, c.currentStep, c.bindingHash]), requestedLimit });

export async function previewCanonicalRelease(requestedLimit: number, deps?: CanonicalReleaseDeps): Promise<CanonicalReleasePreview> {
  const [{ policy, qualified, capacity, capacityDetail, chosen }, control] = await Promise.all([selectForRelease(requestedLimit, deps), readCanonicalReleaseControl()]);
  return {
    snapshotHash: snapshotOf(chosen, requestedLimit), size: chosen.length, requestedLimit, dailyCapacityRemaining: capacity,
    qualifiedPrimaryRecipients: qualified, continuations: chosen.filter(c => c.kind === "continuation").length,
    recipients: chosen.map(c => ({ enrollmentId: c.enrollmentId, businessId: c.businessId, county: c.county, vertical: c.vertical,
      sequenceId: c.sequenceId, kind: c.kind, currentStep: c.currentStep, bindingHash: c.bindingHash })),
    policy, capacity: capacityDetail, releases: control.releases,
    notes: [
      "Primary candidates pass every recorded-fact check. Consent, hygiene and send policy is re-run for the selected recipients, here and again at execution and at every send.",
      "Size is the smaller of the requested limit, the administrator policy limit, actual capacity of the selected sender today and qualified recipients.",
      "Releasing does not lift the outbound pause. A released recipient still needs every ordinary send check to pass.",
      "Each recipient is bound to its exact address, business, sequence and package content; the binding is rechecked at execution and at every send.",
      "The snapshot hash changes if any selected recipient, its binding, its sequence or the limit changes.",
    ],
  };
}

// ── Execute ──────────────────────────────────────────────────────────────────
export async function executeCanonicalRelease(input: {
  requestedLimit: number; snapshotHash: string; commandKey: string; expiresInHours: number; actorId: string;
  deps?: CanonicalReleaseDeps; now?: Date;
}): Promise<{ replayed: boolean; release: ReleaseRecord; control: CanonicalReleaseControl }> {
  const now = input.now ?? new Date();
  const policy = await readReleasePolicy();
  if (!input.commandKey || input.commandKey.length > 200) throw new CanonicalReleaseError("COMMAND_KEY_REQUIRED", 400);
  if (!Number.isInteger(input.expiresInHours) || input.expiresInHours < 1 || input.expiresInHours > policy.maxAdmissionWindowHours) {
    throw new CanonicalReleaseError("RELEASE_EXPIRY_INVALID", 400, `expiresInHours must be 1-${policy.maxAdmissionWindowHours}`);
  }
  const commandKeyHash = sha(input.commandKey);
  const existing = await readCanonicalReleaseControl();
  const replay = existing.releases.find(r => r.commandKeyHash === commandKeyHash);
  if (replay) return { replayed: true, release: replay, control: existing };

  const { chosen } = await selectForRelease(input.requestedLimit, input.deps);
  if (chosen.length === 0) throw new CanonicalReleaseError("NOTHING_TO_RELEASE", 409);
  if (snapshotOf(chosen, input.requestedLimit) !== input.snapshotHash) throw new CanonicalReleaseError("RELEASE_SNAPSHOT_DRIFT", 409);
  // The journey deadline must cover the approved schedule for every chosen sequence.
  for (const sequenceId of new Set(chosen.map(c => c.sequenceId))) {
    const need = (await scheduleDays(sequenceId)) + 1;
    if (policy.journeyDays < need) {
      throw new CanonicalReleaseError("JOURNEY_POLICY_TOO_SHORT", 409, `The journey period (${policy.journeyDays} days) is shorter than the approved schedule (${need} days).`);
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [LOCK_KEY]);
    const locked = await client.query(`SELECT value FROM system_settings WHERE key=$1 FOR UPDATE`, [CANONICAL_RELEASE_CONTROL_KEY]);
    const current = parseControl(locked.rows[0]?.value);
    const replayed = current.releases.find(r => r.commandKeyHash === commandKeyHash);
    if (replayed) { await client.query("COMMIT"); return { replayed: true, release: replayed, control: current }; }
    if (current.releases.some(r => admissionOpen(r, now))) throw new CanonicalReleaseError("ACTIVE_RELEASE_EXISTS", 409);

    const releaseId = randomUUID();
    const releasedAt = now.toISOString();
    const admissionClosesAt = new Date(now.getTime() + input.expiresInHours * 3_600_000).toISOString();
    const journeyExpiresAt = new Date(now.getTime() + policy.journeyDays * 86_400_000).toISOString();
    for (const recipient of chosen) {
      // Recheck the exact approved facts while holding the contact/intent rows, so a change between selection and
      // this write cannot be released under a stale approval.
      const b = recipient.binding;
      const facts = await client.query(
        `SELECT i.id FROM cr04_enrollment_intents i JOIN contacts c ON c.id=i.contact_id
           JOIN businesses b ON b.id=i.business_id AND b.id=c.business_id
           JOIN sfp_programs p ON p.id=i.program_id
           JOIN follow_up_sequences seq ON seq.id=i.sequence_id AND seq.retired_at IS NULL
          WHERE i.id=$1::uuid AND i.preparation_state='ready_held' AND i.normalized_email_hash=$2
            AND encode(sha256(convert_to(lower(trim(c.email)),'UTF8')),'hex')=$2
            AND c.email_mutation_generation IS NOT DISTINCT FROM $3::int AND c.archived_at IS NULL
            AND COALESCE(c.do_not_contact,FALSE)=FALSE AND COALESCE(c.opted_out_email,FALSE)=FALSE
            AND COALESCE(c.email_status,'unvalidated') NOT IN ('invalid','bounced','unsafe','opted_out')
            AND i.preparation_snapshot->>'contentHash' IS NOT DISTINCT FROM $4::text
            AND (${preparedFactsCurrentSql()})
          FOR SHARE OF c, i`,
        [b.intentId, b.emailHash, b.emailGeneration, b.contentHash]);
      if (facts.rowCount !== 1) throw new CanonicalReleaseError("RELEASE_FACTS_CHANGED", 409);
      const marker = {
        releaseId, releasedAt, releasedBy: input.actorId, kind: recipient.kind, admissionClosesAt, journeyExpiresAt,
        bindingHash: recipient.bindingHash, binding: recipient.binding, evidence: recipient.evidence,
      };
      const guard = recipient.kind === "continuation"
        ? `e.status='paused' AND e.current_step>0 AND e.metadata->'canonicalRelease'->>'endedReason' = ANY($5::text[])`
        : `e.status='paused' AND e.current_step=0 AND (NOT (COALESCE(e.metadata,'{}'::jsonb) ? 'canonicalRelease')
             OR e.metadata->'canonicalRelease'->>'endedReason' = ANY($5::text[]))`;
      const updated = await client.query(
        `UPDATE sequence_enrollments e SET status='active',
                -- A continued journey keeps the due time its last confirmed send implies: never earlier than release time,
                -- never earlier than (last confirmed send + the next step's delay). A first touch has no send, so it is due now.
                next_action_at=GREATEST($3::timestamptz, COALESCE(
                  (SELECT max(l.sent_at) FROM outbound_send_log l WHERE l.sequence_enrollment_id=e.id
                      AND l.status IN ('sent','delivered','bounced','complained') AND l.sent_at IS NOT NULL)
                  + (SELECT make_interval(days=>COALESCE(s.delay_days,0), hours=>COALESCE(s.delay_hours,0))
                       FROM sequence_steps s WHERE s.sequence_id=e.sequence_id ORDER BY s.step_order OFFSET e.current_step LIMIT 1),
                  $3::timestamptz)),
                updated_at=NOW(),
                metadata = (COALESCE(e.metadata,'{}'::jsonb) - 'canonicalRelease') || jsonb_build_object(
                  'outboundAuthorized', true, 'canonicalRelease', $2::jsonb,
                  'canonicalReleaseHistory', COALESCE(e.metadata->'canonicalReleaseHistory','[]'::jsonb)
                     || CASE WHEN e.metadata ? 'canonicalRelease' THEN jsonb_build_array(e.metadata->'canonicalRelease') ELSE '[]'::jsonb END)
          WHERE e.id=$1 AND ${guard}
            AND e.metadata->>'canonicalPreparationId'=$4
            AND EXISTS (SELECT 1 FROM cr04_enrollment_intents i WHERE i.id=$4::uuid
                          AND i.enrollment_id=e.id AND i.contact_id=e.contact_id AND i.sequence_id=e.sequence_id
                          AND i.preparation_state='ready_held')
          RETURNING e.id`,
        [recipient.enrollmentId, JSON.stringify(marker), releasedAt, recipient.intentId, [...CONTINUABLE_ENDED_REASONS]]);
      if (updated.rowCount !== 1) throw new CanonicalReleaseError("RELEASE_MEMBERSHIP_CHANGED", 409);
    }
    const record: ReleaseRecord = {
      releaseId, commandKeyHash, snapshotHash: input.snapshotHash, enrollmentIds: chosen.map(c => c.enrollmentId),
      releasedBy: input.actorId, releasedAt, admissionClosesAt, journeyExpiresAt,
      admissionClosedAt: null, journeyEndedAt: null, revokedBy: null, revokedAt: null,
    };
    const next = { releases: [...current.releases, record] };
    await writeControl(client, next, now);
    await client.query("COMMIT");
    return { replayed: false, release: record, control: next };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ── Revoke and lifecycle reconciliation ──────────────────────────────────────
type Q = { query: (q: string, p?: unknown[]) => Promise<any> };

/** Unsent first touches return to the held pool; every other in-flight journey pauses in place with an explicit reason. */
async function applyRevocation(client: Q, release: ReleaseRecord, now: Date): Promise<{ unmarked: number; ended: number }> {
  const unmarked = await client.query(
    `UPDATE sequence_enrollments e SET status='paused', next_action_at=NULL, updated_at=NOW(),
            metadata=(COALESCE(e.metadata,'{}'::jsonb) - 'canonicalRelease') || '{"outboundAuthorized":false}'::jsonb
      WHERE e.id=ANY($1::int[]) AND e.status='active' AND e.current_step=0
        AND e.metadata->'canonicalRelease'->>'releaseId'=$2
        AND NOT EXISTS (SELECT 1 FROM outbound_send_log l WHERE l.sequence_enrollment_id=e.id
                          AND l.status IN ('sent','dispatching','delivered','bounced','complained'))`,
    [release.enrollmentIds, release.releaseId]);
  const ended = await client.query(
    `UPDATE sequence_enrollments e SET status='paused', next_action_at=NULL, updated_at=NOW(),
            metadata=COALESCE(e.metadata,'{}'::jsonb) || jsonb_build_object('outboundAuthorized',false,'canonicalRelease',
              (e.metadata->'canonicalRelease') || jsonb_build_object('endedReason','revoked','endedAt',$3::text))
      WHERE e.id=ANY($1::int[]) AND e.status='active' AND e.metadata->'canonicalRelease'->>'releaseId'=$2`,
    [release.enrollmentIds, release.releaseId, now.toISOString()]);
  return { unmarked: unmarked.rowCount ?? 0, ended: ended.rowCount ?? 0 };
}

/** Revokes every release that still has live authority. Journeys already started are paused, never restarted. */
export async function revokeCanonicalRelease(actorId: string, now: Date = new Date()): Promise<{ revoked: boolean; repaused: number; halted: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [LOCK_KEY]);
    const locked = await client.query(`SELECT value FROM system_settings WHERE key=$1 FOR UPDATE`, [CANONICAL_RELEASE_CONTROL_KEY]);
    const current = parseControl(locked.rows[0]?.value);
    const live = current.releases.filter(r => journeyLive(r, now));
    if (live.length === 0) { await client.query("COMMIT"); return { revoked: false, repaused: 0, halted: 0 }; }
    let repaused = 0; let halted = 0;
    for (const release of live) {
      const result = await applyRevocation(client, release, now);
      repaused += result.unmarked; halted += result.ended;
      release.revokedBy = actorId; release.revokedAt = now.toISOString();
    }
    await writeControl(client, current, now);
    await client.query("COMMIT");
    return { revoked: true, repaused, halted };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export interface ReconcileSummary { admissionsClosed: number; unsentReturnedToHeld: number; journeysEnded: number }

/**
 * Applies the two deadlines. Runs on every scheduler tick, BEFORE deciding whether any release is live, so an
 * expired release is always cleaned up. When the admission window closes, unsent first touches return to held;
 * when a journey deadline passes, started journeys pause in place and stay eligible for an explicit new release.
 */
export async function reconcileCanonicalReleases(now: Date = new Date()): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { admissionsClosed: 0, unsentReturnedToHeld: 0, journeysEnded: 0 };
  const peek = await readCanonicalReleaseControl();
  // A generic send gate (consent, validation, suppression) may have paused a released journey without recording
  // why. Record it so the stop is explicit and operator-visible; it is deliberately not continuable.
  const released = [...new Set(peek.releases.flatMap(r => r.enrollmentIds))];
  if (released.length > 0) {
    await pool.query(
      `UPDATE sequence_enrollments e SET metadata=jsonb_set(e.metadata,'{canonicalRelease}',
          (e.metadata->'canonicalRelease') || jsonb_build_object('endedReason','send_gate_stopped','endedAt',$2::text))
        WHERE e.id=ANY($1::int[]) AND e.status='paused' AND e.metadata ? 'canonicalRelease'
          AND NOT (e.metadata->'canonicalRelease' ? 'endedReason') AND NOT (e.metadata->'canonicalRelease' ? 'hold')`,
      [released, now.toISOString()]);
  }
  const needs = peek.releases.some(r => (!r.admissionClosedAt && !r.revokedAt && !admissionOpen(r, now)) || (!r.journeyEndedAt && !r.revokedAt && !journeyLive(r, now)));
  if (!needs) return summary;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [LOCK_KEY]);
    const locked = await client.query(`SELECT value FROM system_settings WHERE key=$1 FOR UPDATE`, [CANONICAL_RELEASE_CONTROL_KEY]);
    const current = parseControl(locked.rows[0]?.value);
    for (const release of current.releases) {
      if (release.revokedAt) continue;
      if (!release.admissionClosedAt && !admissionOpen(release, now)) {
        const r = await client.query(
          `UPDATE sequence_enrollments e SET status='paused', next_action_at=NULL, updated_at=NOW(),
                  metadata=(COALESCE(e.metadata,'{}'::jsonb) - 'canonicalRelease') || '{"outboundAuthorized":false}'::jsonb
            WHERE e.id=ANY($1::int[]) AND e.status='active' AND e.current_step=0
              AND e.metadata->'canonicalRelease'->>'releaseId'=$2
              AND NOT EXISTS (SELECT 1 FROM outbound_send_log l WHERE l.sequence_enrollment_id=e.id
                                AND l.status IN ('sent','dispatching','delivered','bounced','complained'))`,
          [release.enrollmentIds, release.releaseId]);
        release.admissionClosedAt = now.toISOString();
        summary.admissionsClosed++; summary.unsentReturnedToHeld += r.rowCount ?? 0;
      }
      if (!release.journeyEndedAt && !journeyLive(release, now)) {
        const r = await client.query(
          `UPDATE sequence_enrollments e SET status='paused', next_action_at=NULL, updated_at=NOW(),
                  metadata=COALESCE(e.metadata,'{}'::jsonb) || jsonb_build_object('outboundAuthorized',false,'canonicalRelease',
                    (e.metadata->'canonicalRelease') || jsonb_build_object('endedReason','journey_expired','endedAt',$3::text))
            WHERE e.id=ANY($1::int[]) AND e.status='active' AND e.metadata->'canonicalRelease'->>'releaseId'=$2`,
          [release.enrollmentIds, release.releaseId, now.toISOString()]);
        release.journeyEndedAt = now.toISOString();
        summary.journeysEnded += r.rowCount ?? 0;
      }
    }
    await writeControl(client, current, now);
    await client.query("COMMIT");
    return summary;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
/** Backward-compatible name used by the sequence worker. */
export const reconcileExpiredCanonicalRelease = reconcileCanonicalReleases;

// ── Holds and operator resolution of uncertain sends ─────────────────────────
export const CANONICAL_HOLD_CODES = ["UNCERTAIN_DELIVERY", "REPEATED_UNSENT", "SEND_ATTEMPT_FAILED"] as const;
export const MAX_UNSENT_RETRIES = 5;

/** Pauses a journey in place with an explicit, operator-visible hold. Step, ownership and receipts are untouched. */
export async function holdCanonicalEnrollment(
  enrollmentId: number, hold: string, detail: Record<string, unknown> = {}, now: Date = new Date(),
): Promise<boolean> {
  const r = await pool.query(
    `UPDATE sequence_enrollments SET status='paused', next_action_at=NULL, updated_at=NOW(),
            metadata=COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('canonicalRelease',
              COALESCE(metadata->'canonicalRelease','{}'::jsonb) || jsonb_build_object('hold',$2::text,'holdAt',$3::text,'holdDetail',$4::jsonb))
      WHERE id=$1 AND status='active' AND COALESCE(metadata,'{}'::jsonb) ? 'canonicalRelease'`,
    [enrollmentId, hold, now.toISOString(), JSON.stringify(detail)]);
  return (r.rowCount ?? 0) > 0;
}

/** Counts a proven-unsent attempt for the current step; returns the new count for this step. */
export async function recordUnsentRetry(enrollmentId: number, stepOrder: number): Promise<number> {
  const r = await pool.query(
    `UPDATE sequence_enrollments SET metadata=COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('canonicalRelease',
        COALESCE(metadata->'canonicalRelease','{}'::jsonb) || jsonb_build_object('unsentRetries',
          CASE WHEN (metadata->'canonicalRelease'->>'unsentRetryStep')::int = $2
               THEN COALESCE((metadata->'canonicalRelease'->>'unsentRetries')::int,0)+1 ELSE 1 END,
          'unsentRetryStep',$2))
      WHERE id=$1 RETURNING (metadata->'canonicalRelease'->>'unsentRetries')::int AS n`,
    [enrollmentId, stepOrder]);
  return Number(r.rows[0]?.n ?? 1);
}

/** Records the capacity reservation an uncertain send keeps, so an operator can later settle it truthfully. */
export async function recordHeldReservation(enrollmentId: number, reservation: { day: string; identityId: number }, idempotencyKey: string) {
  await pool.query(
    `UPDATE sequence_enrollments SET metadata=COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('canonicalRelease',
        COALESCE(metadata->'canonicalRelease','{}'::jsonb) || jsonb_build_object('heldReservation',$2::jsonb,'heldIdempotencyKey',$3::text))
      WHERE id=$1`, [enrollmentId, JSON.stringify(reservation), idempotencyKey]);
}

export type HoldResolution = "delivered" | "not_delivered" | "clear_hold";

/**
 * Operator decision for a held journey. "delivered": the provider confirmed the message was sent; record it and
 * keep the allowance used. "not_delivered": confirmed not sent; free the allowance and reopen the same step.
 * "clear_hold": resume a hold that involved no send (e.g. repeated pre-send failures). Never automatic.
 */
export async function resolveCanonicalHold(
  enrollmentId: number, resolution: HoldResolution, now: Date = new Date(),
): Promise<{ resolved: boolean; reason?: string }> {
  // One transaction: the enrollment row lock serializes concurrent resolutions, so the hold is consumed once; the send
  // attempt update and the capacity settlement commit or roll back together with it.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = (await client.query(
      `SELECT status, metadata FROM sequence_enrollments WHERE id=$1 FOR UPDATE`, [enrollmentId])).rows[0];
    const marker = row?.metadata?.canonicalRelease;
    if (!row || row.status !== "paused" || !marker?.hold) { await client.query("ROLLBACK"); return { resolved: false, reason: "NO_HOLD" }; }
    const refuse = async (reason: string) => { await client.query("ROLLBACK"); return { resolved: false, reason }; };
    if (marker.hold === "UNCERTAIN_DELIVERY") {
      const key: string | undefined = marker.heldIdempotencyKey;
      if (!key) return refuse("HELD_ATTEMPT_UNKNOWN");
      if (resolution === "delivered") {
        const sent = await client.query(
          `UPDATE outbound_send_log SET status='sent', sent_at=COALESCE(sent_at,NOW()), updated_at=NOW()
            WHERE idempotency_key=$1 AND sequence_enrollment_id=$2 AND status IN ('pending','dispatching','sent') RETURNING id`, [key, enrollmentId]);
        if (sent.rowCount !== 1) return refuse("HELD_ATTEMPT_NOT_SETTLEABLE");
      } else if (resolution === "not_delivered") {
        const reopened = await client.query(
          `UPDATE outbound_send_log SET status='pending', claim_expires_at=NOW() - INTERVAL '1 second', updated_at=NOW(),
                  failure_reason='operator_confirmed_not_delivered'
            WHERE idempotency_key=$1 AND sequence_enrollment_id=$2 AND status IN ('pending','dispatching') RETURNING id`, [key, enrollmentId]);
        // A failure to reopen means the attempt is not provably unsent: the journey stays held and nothing is freed.
        if (reopened.rowCount !== 1) return refuse("HELD_ATTEMPT_NOT_REOPENABLE");
        if (marker.heldReservation) {
          const { releaseSenderCapacity } = await import("./sfp-sender-capacity");
          await releaseSenderCapacity(marker.heldReservation, client);
        }
      } else return refuse("UNCERTAIN_DELIVERY_REQUIRES_DECISION");
    } else if (resolution !== "clear_hold") {
      return refuse("RESOLUTION_NOT_APPLICABLE");
    }
    const r = await client.query(
      `UPDATE sequence_enrollments SET status='active', next_action_at=$2::timestamptz, updated_at=NOW(),
              metadata=jsonb_set(metadata,'{canonicalRelease}',(metadata->'canonicalRelease')
                - 'hold' - 'holdAt' - 'holdDetail' - 'heldReservation' - 'heldIdempotencyKey' - 'unsentRetries' - 'unsentRetryStep')
        WHERE id=$1 AND status='paused' AND metadata->'canonicalRelease' ? 'hold'`, [enrollmentId, now.toISOString()]);
    if ((r.rowCount ?? 0) !== 1) return refuse("NO_HOLD");
    await client.query("COMMIT");
    return { resolved: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ── Status for the operator UI ───────────────────────────────────────────────
export async function describeCanonicalRelease(now: Date = new Date()) {
  const [control, policy] = await Promise.all([readCanonicalReleaseControl(), readReleasePolicy()]);
  const journeys = await pool.query(
    `SELECT COALESCE(e.metadata->'canonicalRelease'->>'endedReason', CASE WHEN e.status='active' THEN 'in_progress' ELSE e.status END) AS state, count(*)::int AS n
       FROM sequence_enrollments e WHERE COALESCE(e.metadata,'{}'::jsonb) ? 'canonicalRelease' GROUP BY 1`);
  const held = await pool.query(
    `SELECT COALESCE(e.metadata->'canonicalRelease'->>'hold','') AS hold, count(*)::int AS n FROM sequence_enrollments e
      WHERE e.status='paused' AND COALESCE(e.metadata,'{}'::jsonb) ? 'canonicalRelease' AND e.metadata->'canonicalRelease' ? 'hold' GROUP BY 1`);
  const heldList = await pool.query(
    `SELECT e.id, e.metadata->'canonicalRelease'->>'hold' AS hold, e.metadata->'canonicalRelease'->>'holdAt' AS "holdAt"
       FROM sequence_enrollments e WHERE e.status='paused' AND e.metadata->'canonicalRelease' ? 'hold' ORDER BY e.id LIMIT 25`);
  const latest = [...control.releases].sort((a, b) => ms(b.releasedAt) - ms(a.releasedAt))[0] ?? null;
  return {
    releases: control.releases,
    latest,
    admissionOpen: control.releases.some(r => admissionOpen(r, now)),
    live: controlHasLiveAuthority(control, now),
    journeys: Object.fromEntries(journeys.rows.map(r => [String(r.state), Number(r.n)])),
    holds: Object.fromEntries(held.rows.map(r => [String(r.hold), Number(r.n)])),
    heldEnrollments: heldList.rows.map(r => ({ id: Number(r.id), hold: String(r.hold), holdAt: r.holdAt ?? null })),
    policy, bounds: RELEASE_POLICY_BOUNDS,
    // Compatibility with the earlier single-release shape.
    maxSize: policy.maxRecipientsPerRelease, maxHours: policy.maxAdmissionWindowHours,
    control: {
      enabled: latest ? journeyLive(latest, now) : false, releaseId: latest?.releaseId ?? null,
      expiresAt: latest?.admissionClosesAt ?? null, journeyExpiresAt: latest?.journeyExpiresAt ?? null,
      enrollmentIds: latest?.enrollmentIds ?? [], releasedAt: latest?.releasedAt ?? null,
    },
  };
}
