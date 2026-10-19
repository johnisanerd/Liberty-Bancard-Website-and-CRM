/**
 * Outbound Send Log — durable per-touch record and idempotency gate.
 *
 * Every sequence step send is recorded here BEFORE and AFTER the network call:
 *   1. hasSentStep()      → idempotency check (was this step already sent?)
 *   2. openSendAttempt()  → write a 'pending' row (reserve the slot)
 *   3. markSendSent()     → update to 'sent' + provider_message_id
 *   4. markSendFailed()   → update to 'failed' + failure_reason
 *
 * Idempotency key format: seq-{enrollmentId}-s{stepOrder}
 * This makes each step permanently idempotent per enrollment regardless of day.
 *
 * All DB calls use raw SQL (db.execute) to avoid circular import issues with schema.
 */

import { db, pool } from "../db";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { communicationContactLockKey } from "./communication-contact-lock";

export type SendChannel = "email_gmail" | "email_ghl" | "email_smtp" | "sms_ghl";
export type SendStatus  = "pending" | "dispatching" | "sent" | "failed" | "skipped" | "bounced" | "delivered" | "complained";

export interface SendLogRecord {
  id: number;
  idempotencyKey: string;
  sequenceId: number | null;
  sequenceEnrollmentId: number | null;
  contactId: number | null;
  stepOrder: number | null;
  channel: string;
  fromAddress: string | null;
  toAddress: string;
  subject: string | null;
  providerMessageId: string | null;
  status: string;
  failureReason: string | null;
  sentAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
}

export interface SendAttemptClaim {
  attemptId: number;
  claimToken: string;
}

/** Format: seq-{enrollmentId}-s{stepOrder} */
export function buildIdempotencyKey(enrollmentId: number, stepOrder: number): string {
  return `seq-${enrollmentId}-s${stepOrder}`;
}

/** Returns true if this step was already successfully sent (status='sent'). */
export async function hasSentStep(idempotencyKey: string): Promise<boolean> {
  try {
    const result = await db.execute(sql`
      SELECT id FROM outbound_send_log
      WHERE idempotency_key = ${idempotencyKey} AND status = 'sent'
      LIMIT 1
    `);
    return result.rows.length > 0;
  } catch {
    return false;
  }
}

/** Get any existing log row for this key (regardless of status). */
export async function getSendLogByKey(idempotencyKey: string): Promise<SendLogRecord | null> {
  try {
    const result = await db.execute(sql`
      SELECT id, idempotency_key, sequence_id, sequence_enrollment_id, contact_id,
             step_order, channel, from_address, to_address, subject,
             provider_message_id, status, failure_reason, sent_at, failed_at, created_at
      FROM outbound_send_log
      WHERE idempotency_key = ${idempotencyKey}
      LIMIT 1
    `);
    if (result.rows.length === 0) return null;
    const r = result.rows[0] as any;
    return {
      id:                   r.id,
      idempotencyKey:       r.idempotency_key,
      sequenceId:           r.sequence_id,
      sequenceEnrollmentId: r.sequence_enrollment_id,
      contactId:            r.contact_id,
      stepOrder:            r.step_order,
      channel:              r.channel,
      fromAddress:          r.from_address,
      toAddress:            r.to_address,
      subject:              r.subject,
      providerMessageId:    r.provider_message_id,
      status:               r.status,
      failureReason:        r.failure_reason,
      sentAt:               r.sent_at ? new Date(r.sent_at) : null,
      failedAt:             r.failed_at ? new Date(r.failed_at) : null,
      createdAt:            new Date(r.created_at),
    };
  } catch {
    return null;
  }
}

/**
 * Lease-backed send claim. A new row is inserted pending. Only an expired
 * pending lease may be reclaimed; dispatching/failed/sent are permanently
 * ineligible because provider outcomes can be ambiguous.
 *
 * recordClassAtEvent is captured at claim time and is immutable on the row —
 * it reflects the commercial class at the moment the send was authorized,
 * not at reporting time (BT-06).
 */
export async function openSendAttempt(params: {
  idempotencyKey: string;
  sequenceId?: number;
  sequenceEnrollmentId?: number;
  contactId?: number;
  stepOrder?: number;
  channel: SendChannel;
  fromAddress?: string;
  toAddress: string;
  subject?: string;
  /** BT-06: commercial class at the moment of claim — captured once, immutable. */
  recordClassAtEvent?: string;
}): Promise<SendAttemptClaim | null> {
  // Resolve commercial class at claim time if not provided by caller.
  let classAtEvent = params.recordClassAtEvent ?? "unknown";
  if (classAtEvent === "unknown" && params.contactId) {
    try {
      const { getCurrentClass } = await import("./commercial-classification-authority");
      classAtEvent = await getCurrentClass("contact", params.contactId);
    } catch {
      // Fall back to 'unknown' if classification tables not yet migrated.
    }
  }

  const claimToken = randomUUID();
  try {
    const result = await db.execute(sql`
      INSERT INTO outbound_send_log
        (idempotency_key, sequence_id, sequence_enrollment_id, contact_id,
         step_order, channel, from_address, to_address, subject,
         status, record_class_at_event, claim_token, claim_expires_at, created_at, updated_at)
      VALUES
        (${params.idempotencyKey},
         ${params.sequenceId ?? null},
         ${params.sequenceEnrollmentId ?? null},
         ${params.contactId ?? null},
         ${params.stepOrder ?? null},
         ${params.channel},
         ${params.fromAddress ?? null},
         ${params.toAddress},
         ${params.subject ?? null},
         'pending', ${classAtEvent}, ${claimToken}::uuid, NOW() + INTERVAL '5 minutes', NOW(), NOW())
       ON CONFLICT (idempotency_key) DO UPDATE
       SET claim_token = EXCLUDED.claim_token,
           claim_expires_at = EXCLUDED.claim_expires_at,
           updated_at = NOW()
       WHERE outbound_send_log.status = 'pending'
         AND outbound_send_log.claim_expires_at < NOW()
      RETURNING id, claim_token
    `);
    if (result.rows.length === 0) return null;
    return {
      attemptId: Number((result.rows[0] as any).id),
      claimToken: String((result.rows[0] as any).claim_token),
    };
  } catch (err: any) {
    // If the column doesn't exist yet (pre-migration window), fall back to
    // the original INSERT without the classification column.
    const msg = err?.message ?? String(err);
    if (msg.includes("record_class_at_event") && msg.includes("does not exist")) {
      try {
        const result2 = await db.execute(sql`
          INSERT INTO outbound_send_log
            (idempotency_key, sequence_id, sequence_enrollment_id, contact_id,
             step_order, channel, from_address, to_address, subject,
              status, claim_token, claim_expires_at, created_at, updated_at)
          VALUES
            (${params.idempotencyKey},
             ${params.sequenceId ?? null},
             ${params.sequenceEnrollmentId ?? null},
             ${params.contactId ?? null},
             ${params.stepOrder ?? null},
             ${params.channel},
             ${params.fromAddress ?? null},
             ${params.toAddress},
             ${params.subject ?? null},
              'pending', ${claimToken}::uuid, NOW() + INTERVAL '5 minutes', NOW(), NOW())
           ON CONFLICT (idempotency_key) DO UPDATE
           SET claim_token = EXCLUDED.claim_token,
               claim_expires_at = EXCLUDED.claim_expires_at,
               updated_at = NOW()
           WHERE outbound_send_log.status = 'pending'
             AND outbound_send_log.claim_expires_at < NOW()
          RETURNING id, claim_token
        `);
        if (result2.rows.length === 0) return null;
        return {
          attemptId: Number((result2.rows[0] as any).id),
          claimToken: String((result2.rows[0] as any).claim_token),
        };
      } catch (err2) {
        console.warn("[SendLog] openSendAttempt fallback error (non-fatal):", err2);
        return null;
      }
    }
    console.warn("[SendLog] openSendAttempt error (non-fatal):", err);
    return null;
  }
}

export type DispatchAuthorization =
  | { outcome: "AUTHORIZED"; attemptId: number }
  | { outcome: "NOT_AUTHORIZED" }
  | { outcome: "UNAVAILABLE" };

/**
 * Provider-I/O linearization point for sequence sends. The owned pending row
 * becomes dispatching only in the same SQL statement/snapshot that confirms the
 * expected enrollment version is active and no canonical inbound event exists.
 */
export async function authorizeSequenceDispatch(params: {
  attemptId: number;
  claimToken: string;
  idempotencyKey: string;
  enrollmentId: number;
  expectedCurrentStep: number;
  contactId: number;
  enrolledAt: Date;
}): Promise<DispatchAuthorization> {
  const client = await pool.connect().catch(() => null);
  if (!client) return { outcome: "UNAVAILABLE" };
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
      communicationContactLockKey(params.contactId).toString(),
    ]);
    const result = await client.query<{ id: number }>(`
      UPDATE outbound_send_log AS send_attempt
      SET status = 'dispatching',
          claim_token = NULL,
          claim_expires_at = NULL,
          updated_at = NOW()
      WHERE send_attempt.id = $1
        AND send_attempt.claim_token = $2::uuid
        AND send_attempt.idempotency_key = $3
        AND send_attempt.status = 'pending'
        AND send_attempt.claim_expires_at > NOW()
        AND send_attempt.sequence_enrollment_id = $4
        AND EXISTS (
          SELECT 1 FROM sequence_enrollments AS enrollment
          WHERE enrollment.id = $4
            AND enrollment.status = 'active'
            AND enrollment.current_step = $5
            AND enrollment.contact_id = $6
        )
        AND NOT EXISTS (
          SELECT 1 FROM communication_events AS inbound
          WHERE inbound.contact_id = $6
            AND inbound.direction = 'inbound'
            AND inbound.created_at > $7
        )
      RETURNING send_attempt.id
    `, [
      params.attemptId,
      params.claimToken,
      params.idempotencyKey,
      params.enrollmentId,
      params.expectedCurrentStep,
      params.contactId,
      params.enrolledAt,
    ]);
    await client.query("COMMIT");
    return result.rows.length
      ? { outcome: "AUTHORIZED", attemptId: Number((result.rows[0] as any).id) }
      : { outcome: "NOT_AUTHORIZED" };
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* connection may be broken */ }
    console.warn("[SendLog] sequence dispatch authorization unavailable (failed closed):", err);
    return { outcome: "UNAVAILABLE" };
  } finally {
    client.release();
  }
}

/** Mark a send as successfully sent and record the provider message ID. */
export async function markSendSent(params: {
  idempotencyKey: string;
  providerMessageId?: string;
  fromAddress?: string;
}): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE outbound_send_log
      SET status = 'sent',
          sent_at = NOW(),
          updated_at = NOW(),
          provider_message_id = COALESCE(${params.providerMessageId ?? null}, provider_message_id),
          from_address = COALESCE(${params.fromAddress ?? null}, from_address)
      WHERE idempotency_key = ${params.idempotencyKey}
    `);
  } catch (err) {
    console.warn("[SendLog] markSendSent error (non-fatal):", err);
  }
}

/** Mark a send as failed. */
export async function markSendFailed(params: {
  idempotencyKey: string;
  failureReason: string;
}): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE outbound_send_log
      SET status = 'failed',
          failed_at = NOW(),
          updated_at = NOW(),
          failure_reason = ${params.failureReason}
      WHERE idempotency_key = ${params.idempotencyKey}
    `);
  } catch (err) {
    console.warn("[SendLog] markSendFailed error (non-fatal):", err);
  }
}

/**
 * Definitive non-delivery (the transport proved the message was not accepted, or the dispatch was
 * denied before any I/O): re-open the claim so the same step can be retried. The idempotency key and
 * its history are kept. Never use for an uncertain outcome.
 */
export async function reopenUnsentAttempt(params: { idempotencyKey: string; failureReason: string }): Promise<boolean> {
  try {
    const r = await db.execute(sql`
      UPDATE outbound_send_log
         SET status = 'pending', claim_expires_at = NOW() - INTERVAL '1 second', updated_at = NOW(),
             failure_reason = ${params.failureReason}
       WHERE idempotency_key = ${params.idempotencyKey} AND status IN ('pending','dispatching')
       RETURNING id`);
    return r.rows.length > 0;
  } catch (err) {
    console.warn("[SendLog] reopenUnsentAttempt error:", err);
    return false;
  }
}

/**
 * Update status to 'bounced' or 'complained' when GHL webhook reports it.
 * providerMessageId is used to look up the row if the idempotency key is unknown.
 */
export async function updateSendStatusByProvider(params: {
  providerMessageId: string;
  status: "bounced" | "complained" | "delivered";
  failureReason?: string;
}): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE outbound_send_log
      SET status = ${params.status},
          failure_reason = ${params.failureReason ?? null},
          updated_at = NOW(),
          delivered_at = CASE WHEN ${params.status} = 'delivered' THEN NOW() ELSE delivered_at END,
          failed_at   = CASE WHEN ${params.status} IN ('bounced','complained') THEN NOW() ELSE failed_at END
      WHERE provider_message_id = ${params.providerMessageId}
    `);
  } catch (err) {
    console.warn("[SendLog] updateSendStatusByProvider error (non-fatal):", err);
  }
}

/** Recent send log rows for a contact (descending). */
export async function getRecentSendsForContact(contactId: number, limit = 20): Promise<SendLogRecord[]> {
  try {
    const result = await db.execute(sql`
      SELECT id, idempotency_key, sequence_id, sequence_enrollment_id, contact_id,
             step_order, channel, from_address, to_address, subject,
             provider_message_id, status, failure_reason, sent_at, failed_at, created_at
      FROM outbound_send_log
      WHERE contact_id = ${contactId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `);
    return (result.rows as any[]).map(r => ({
      id:                   r.id,
      idempotencyKey:       r.idempotency_key,
      sequenceId:           r.sequence_id,
      sequenceEnrollmentId: r.sequence_enrollment_id,
      contactId:            r.contact_id,
      stepOrder:            r.step_order,
      channel:              r.channel,
      fromAddress:          r.from_address,
      toAddress:            r.to_address,
      subject:              r.subject,
      providerMessageId:    r.provider_message_id,
      status:               r.status,
      failureReason:        r.failure_reason,
      sentAt:               r.sent_at ? new Date(r.sent_at) : null,
      failedAt:             r.failed_at ? new Date(r.failed_at) : null,
      createdAt:            new Date(r.created_at),
    }));
  } catch {
    return [];
  }
}

/** Summary counts for the readiness dashboard. */
export async function getSendLogSummary(): Promise<{
  totalSent: number;
  totalFailed: number;
  totalBounced: number;
  totalPending: number;
  last24hSent: number;
}> {
  try {
    const result = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'sent')    AS total_sent,
        COUNT(*) FILTER (WHERE status = 'failed')  AS total_failed,
        COUNT(*) FILTER (WHERE status = 'bounced') AS total_bounced,
        COUNT(*) FILTER (WHERE status = 'pending') AS total_pending,
        COUNT(*) FILTER (WHERE status = 'sent' AND sent_at > NOW() - INTERVAL '24 hours') AS last24h_sent
      FROM outbound_send_log
    `);
    const r = (result.rows[0] as any) ?? {};
    return {
      totalSent:    Number(r.total_sent    ?? 0),
      totalFailed:  Number(r.total_failed  ?? 0),
      totalBounced: Number(r.total_bounced ?? 0),
      totalPending: Number(r.total_pending ?? 0),
      last24hSent:  Number(r.last24h_sent  ?? 0),
    };
  } catch {
    return { totalSent: 0, totalFailed: 0, totalBounced: 0, totalPending: 0, last24hSent: 0 };
  }
}
