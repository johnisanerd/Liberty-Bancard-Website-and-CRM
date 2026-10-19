/**
 * Narrow release authority for current canonical SFP recipients.
 *
 * Promotional sequence execution stays refused by the lifecycle authority. This module is the one
 * explicit, operator-driven exception, and it admits only enrollments that
 *   - belong to a canonical SFP sequence,
 *   - were prepared by canonical recipient preparation (owned paused membership), and
 *   - were released by an admin inside the current, unexpired, unrevoked release.
 * Nothing here sends. A released enrollment still has to clear the outbound pause, the coordinator,
 * reply-stop, consent, suppression, validation, sender policy, per-identity capacity and the
 * dispatch authority in the sequence worker. With no active release the control is disabled and the
 * worker behaves exactly as before. Releasing does not lift the outbound pause.
 */
import { createHash, randomUUID } from "node:crypto";
import { pool } from "../db";
import { listQualifiedPrimaryRecipients, type QualifiedReadyHeldRecipient } from "./sfp-launch-inventory";
import { isUsableSenderIdentity, remainingDailyCapacity } from "./sdr/sender-identity-state";

export const CANONICAL_RELEASE_CONTROL_KEY = "sfp_canonical_release_control";
export const CANONICAL_RELEASE_MAX_SIZE = 50;
export const CANONICAL_RELEASE_MAX_HOURS = 72;
const LOCK_KEY = "sfp-canonical-release";

export interface CanonicalReleaseControl {
  enabled: boolean;
  releaseId: string | null;
  expiresAt: string | null;
  commandKeyHash: string | null;
  snapshotHash: string | null;
  enrollmentIds: number[];
  releasedBy: string | null;
  releasedAt: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
}

const DISABLED: CanonicalReleaseControl = {
  enabled: false, releaseId: null, expiresAt: null, commandKeyHash: null, snapshotHash: null,
  enrollmentIds: [], releasedBy: null, releasedAt: null, revokedBy: null, revokedAt: null,
};

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class CanonicalReleaseError extends Error {
  constructor(public readonly code: string, public readonly status = 409, message?: string) {
    super(message ?? code);
  }
}

function parseControl(value: unknown): CanonicalReleaseControl {
  return value && typeof value === "object" ? { ...DISABLED, ...(value as Partial<CanonicalReleaseControl>) } : { ...DISABLED };
}

export function isControlLive(control: CanonicalReleaseControl, now = Date.now()): boolean {
  return control.enabled === true && !!control.releaseId && !!control.expiresAt
    && new Date(control.expiresAt).getTime() > now;
}

export async function readCanonicalReleaseControl(): Promise<CanonicalReleaseControl> {
  const r = await pool.query(`SELECT value FROM system_settings WHERE key=$1`, [CANONICAL_RELEASE_CONTROL_KEY]);
  return parseControl(r.rows[0]?.value);
}

/**
 * True only for an enrollment released under the live control. Fails closed on any read error,
 * missing marker, wrong release, or a non-canonical sequence.
 */
export async function isCanonicalReleaseAdmitted(
  enrollment: { id: number; status?: string | null; metadata?: unknown },
  sequence: { retiredAt?: unknown; triggerConfig?: unknown },
): Promise<boolean> {
  try {
    if (sequence.retiredAt) return false;
    const trigger = (sequence.triggerConfig && typeof sequence.triggerConfig === "object" ? sequence.triggerConfig : {}) as Record<string, unknown>;
    if (typeof trigger.canonicalProgramId !== "string" || !trigger.canonicalProgramId) return false;
    const meta = (enrollment.metadata && typeof enrollment.metadata === "object" ? enrollment.metadata : {}) as Record<string, any>;
    const marker = meta.canonicalRelease;
    if (!marker || typeof marker.releaseId !== "string" || typeof meta.canonicalPreparationId !== "string") return false;
    const control = await readCanonicalReleaseControl();
    return isControlLive(control) && control.releaseId === marker.releaseId && control.enrollmentIds.includes(enrollment.id);
  } catch {
    return false;
  }
}

export interface CanonicalReleasePreview {
  snapshotHash: string;
  size: number;
  requestedLimit: number;
  dailyCapacityRemaining: number;
  qualifiedPrimaryRecipients: number;
  recipients: Array<Pick<QualifiedReadyHeldRecipient, "enrollmentId" | "businessId" | "county" | "vertical" | "sequenceId">>;
  control: CanonicalReleaseControl;
  notes: string[];
}

async function remainingCapacity(): Promise<number> {
  const r = await pool.query(`SELECT is_active AS "isActive", warmup_status AS "warmupStatus",
    daily_limit AS "dailyLimit", sent_today AS "sentToday" FROM sending_identities`);
  const identityRemaining = r.rows.filter(isUsableSenderIdentity).reduce((total, i) => total + remainingDailyCapacity(i), 0);
  // One definition for initial and follow-up sends: the worker reserves every cold step
  // against the same daily cold ceiling, so a release can never be larger than what is
  // left under that ceiling after follow-ups already due in the next 24 hours.
  const { getEffectiveColdDailyCap } = await import("./outbound-cold-cap");
  const ceiling = await getEffectiveColdDailyCap();
  const used = await pool.query(
    `SELECT COALESCE(SUM(count),0)::int AS used FROM outbound_send_counters
      WHERE date=$1 AND channel='email' AND scope='cold_outreach'`, [new Date().toISOString().slice(0, 10)]);
  const followUps = await pool.query(
    `SELECT count(*)::int AS due FROM sequence_enrollments e JOIN follow_up_sequences q ON q.id=e.sequence_id
      WHERE e.status='active' AND e.current_step>0 AND e.next_action_at<=NOW()+INTERVAL '24 hours'
        AND q.sequence_family LIKE 'sfp-v2-cold-%'`);
  const coldRemaining = Math.max(0, ceiling - Number(used.rows[0]?.used ?? 0) - Number(followUps.rows[0]?.due ?? 0));
  return Math.max(0, Math.min(identityRemaining, coldRemaining));
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

async function selectForRelease(requestedLimit: number, deps?: CanonicalReleaseDeps) {
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > CANONICAL_RELEASE_MAX_SIZE) {
    throw new CanonicalReleaseError("RELEASE_LIMIT_INVALID", 400, `limit must be 1-${CANONICAL_RELEASE_MAX_SIZE}`);
  }
  const [allQualified, capacity] = await Promise.all([
    (deps?.listQualified ?? listQualifiedPrimaryRecipients)(), (deps?.capacity ?? remainingCapacity)()]);
  // A sequence with no launch-ready steps must never be released: the worker would otherwise
  // have nothing to send and nothing truthful to record. Checked once per distinct sequence.
  const readyBySequence = new Map<number, boolean>();
  for (const sequenceId of new Set(allQualified.map(r => r.sequenceId))) {
    readyBySequence.set(sequenceId, await sequenceHasLaunchReadyContent(sequenceId));
  }
  const qualified = allQualified.filter(r => readyBySequence.get(r.sequenceId) === true);
  const size = Math.min(requestedLimit, capacity, qualified.length);
  const chosen = qualified.slice(0, size);
  return { qualified, capacity, chosen };
}

export async function previewCanonicalRelease(requestedLimit: number, deps?: CanonicalReleaseDeps): Promise<CanonicalReleasePreview> {
  const [{ qualified, capacity, chosen }, control] = await Promise.all([selectForRelease(requestedLimit, deps), readCanonicalReleaseControl()]);
  const snapshotHash = sha({ ids: chosen.map(c => [c.enrollmentId, c.intentId, c.sequenceId]), requestedLimit });
  return {
    snapshotHash, size: chosen.length, requestedLimit, dailyCapacityRemaining: capacity,
    qualifiedPrimaryRecipients: qualified.length,
    recipients: chosen.map(c => ({ enrollmentId: c.enrollmentId, businessId: c.businessId, county: c.county,
      vertical: c.vertical, sequenceId: c.sequenceId })),
    control,
    notes: [
      "Size is the smaller of the requested limit, remaining sender capacity today and qualified primary recipients.",
      "Releasing does not lift the outbound pause. A released recipient still needs every ordinary send check to pass.",
      "The snapshot hash changes if any selected recipient, its sequence or the limit changes.",
    ],
  };
}

export async function executeCanonicalRelease(input: {
  requestedLimit: number; snapshotHash: string; commandKey: string; expiresInHours: number; actorId: string;
  deps?: CanonicalReleaseDeps;
}): Promise<{ replayed: boolean; control: CanonicalReleaseControl }> {
  if (!input.commandKey || input.commandKey.length > 200) throw new CanonicalReleaseError("COMMAND_KEY_REQUIRED", 400);
  if (!Number.isInteger(input.expiresInHours) || input.expiresInHours < 1 || input.expiresInHours > CANONICAL_RELEASE_MAX_HOURS) {
    throw new CanonicalReleaseError("RELEASE_EXPIRY_INVALID", 400, `expiresInHours must be 1-${CANONICAL_RELEASE_MAX_HOURS}`);
  }
  const commandKeyHash = sha(input.commandKey);
  const existing = await readCanonicalReleaseControl();
  if (existing.commandKeyHash === commandKeyHash) return { replayed: true, control: existing };

  const { chosen } = await selectForRelease(input.requestedLimit, input.deps);
  if (chosen.length === 0) throw new CanonicalReleaseError("NOTHING_TO_RELEASE", 409);
  const snapshotHash = sha({ ids: chosen.map(c => [c.enrollmentId, c.intentId, c.sequenceId]), requestedLimit: input.requestedLimit });
  if (snapshotHash !== input.snapshotHash) throw new CanonicalReleaseError("RELEASE_SNAPSHOT_DRIFT", 409);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [LOCK_KEY]);
    const locked = await client.query(`SELECT value FROM system_settings WHERE key=$1 FOR UPDATE`, [CANONICAL_RELEASE_CONTROL_KEY]);
    const current = parseControl(locked.rows[0]?.value);
    if (current.commandKeyHash === commandKeyHash) { await client.query("COMMIT"); return { replayed: true, control: current }; }
    if (isControlLive(current)) throw new CanonicalReleaseError("ACTIVE_RELEASE_EXISTS", 409);

    const releaseId = randomUUID();
    const releasedAt = new Date().toISOString();
    for (const recipient of chosen) {
      const updated = await client.query(
        `UPDATE sequence_enrollments e SET status='active', next_action_at=NOW(), updated_at=NOW(),
                metadata = COALESCE(e.metadata,'{}'::jsonb) || jsonb_build_object(
                  'outboundAuthorized', true,
                  'canonicalRelease', jsonb_build_object('releaseId',$2::text,'releasedAt',$3::text,'releasedBy',$4::text))
          WHERE e.id=$1 AND e.status='paused' AND e.current_step=0
            AND e.metadata->>'canonicalPreparationId'=$5
            AND NOT (COALESCE(e.metadata,'{}'::jsonb) ? 'canonicalRelease')
            AND EXISTS (SELECT 1 FROM cr04_enrollment_intents i WHERE i.id=$5::uuid
                          AND i.enrollment_id=e.id AND i.preparation_state='ready_held')
        RETURNING e.id`,
        [recipient.enrollmentId, releaseId, releasedAt, input.actorId, recipient.intentId],
      );
      if (updated.rowCount !== 1) throw new CanonicalReleaseError("RELEASE_MEMBERSHIP_CHANGED", 409);
    }
    const control: CanonicalReleaseControl = {
      enabled: true, releaseId, commandKeyHash, snapshotHash,
      expiresAt: new Date(Date.now() + input.expiresInHours * 3_600_000).toISOString(),
      enrollmentIds: chosen.map(c => c.enrollmentId), releasedBy: input.actorId, releasedAt,
      revokedBy: null, revokedAt: null,
    };
    await client.query(
      `INSERT INTO system_settings(key,value,updated_at) VALUES($1,$2::jsonb,NOW())
       ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
      [CANONICAL_RELEASE_CONTROL_KEY, JSON.stringify(control)]);
    await client.query("COMMIT");
    return { replayed: false, control };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Disables the control and returns every released membership to its paused state. */
export async function revokeCanonicalRelease(actorId: string): Promise<{ revoked: boolean; repaused: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [LOCK_KEY]);
    const locked = await client.query(`SELECT value FROM system_settings WHERE key=$1 FOR UPDATE`, [CANONICAL_RELEASE_CONTROL_KEY]);
    const current = parseControl(locked.rows[0]?.value);
    if (!current.releaseId) { await client.query("COMMIT"); return { revoked: false, repaused: 0 }; }
    const repaused = await client.query(
      `UPDATE sequence_enrollments SET status='paused', next_action_at=NULL, updated_at=NOW(),
              metadata=(COALESCE(metadata,'{}'::jsonb) - 'canonicalRelease') || '{"outboundAuthorized":false}'::jsonb
        WHERE id=ANY($1::int[]) AND status='active'
          AND metadata->'canonicalRelease'->>'releaseId'=$2`,
      [current.enrollmentIds, current.releaseId]);
    const next: CanonicalReleaseControl = { ...current, enabled: false, revokedBy: actorId, revokedAt: new Date().toISOString() };
    await client.query(`UPDATE system_settings SET value=$2::jsonb, updated_at=NOW() WHERE key=$1`,
      [CANONICAL_RELEASE_CONTROL_KEY, JSON.stringify(next)]);
    await client.query("COMMIT");
    return { revoked: current.enabled, repaused: repaused.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** An expired release must not leave memberships active and deferring forever. */
export async function reconcileExpiredCanonicalRelease(): Promise<void> {
  const control = await readCanonicalReleaseControl();
  if (control.enabled && control.releaseId && !isControlLive(control)) await revokeCanonicalRelease("system:release-expiry");
}
