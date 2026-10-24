/**
 * Durable GHL webhook receipts (#2105 C6).
 *
 * Previous behavior inserted a de-duplication row BEFORE the handler ran and treated storage
 * errors as "process anyway". A handler failure therefore turned GHL's retry into a silent
 * duplicate (the event was never applied) and a storage fault allowed double processing.
 *
 * Now: received -> claimed -> applied | failed.
 *  - A new event is claimed with a short lease and processed.
 *  - A retry after `failed` or an expired lease re-claims the same receipt.
 *  - Only an `applied` receipt makes a duplicate harmless (200, no reprocessing).
 *  - A duplicate that arrives while another delivery holds a live claim gets a non-2xx so GHL retries.
 *  - The receipt is marked BEFORE the HTTP acknowledgement is released.
 *  - Storage failure is fail-closed (503); the sender retries.
 */
import { createHash, randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { pool } from "../db";

export const RECEIPT_LEASE_SECONDS = 120;

export type ReceiptClaim =
  | { decision: "process"; receiptId: string; claimToken: string; attempt: number }
  | { decision: "duplicate_applied"; receiptId: string }
  | { decision: "in_flight"; receiptId: string };

export interface ReceiptMeta {
  locationId?: string | null;
  calendarId?: string | null;
  remoteEventId?: string | null;
  appointmentId?: string | null;
  ghlContactId?: string | null;
  eventAt?: Date | null;
}

export function ghlWebhookEventKey(eventType: string, rawBody: string): string {
  return createHash("sha256").update(`${eventType}:${rawBody}`).digest("hex");
}

export function extractReceiptMeta(body: unknown): ReceiptMeta {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, any>;
  const appointment = (b.appointment && typeof b.appointment === "object" ? b.appointment : {}) as Record<string, any>;
  const text = (v: unknown) => (typeof v === "string" && v.length > 0 ? v.slice(0, 200) : null);
  const rawTime = b.dateUpdated ?? b.dateAdded ?? b.timestamp ?? b.createdAt ?? appointment.dateUpdated ?? appointment.dateAdded;
  const parsed = rawTime ? new Date(rawTime) : null;
  return {
    locationId: text(b.locationId ?? b.location_id ?? appointment.locationId),
    calendarId: text(b.calendarId ?? appointment.calendarId),
    remoteEventId: text(b.eventId ?? b.webhookId ?? b.id),
    appointmentId: text(b.appointmentId ?? appointment.id ?? b.id),
    ghlContactId: text(b.contactId ?? appointment.contactId),
    eventAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
  };
}

export async function claimGhlWebhookReceipt(eventKey: string, eventType: string, meta: ReceiptMeta = {}): Promise<ReceiptClaim> {
  const claimToken = randomUUID();
  const claimed = await pool.query(
    `INSERT INTO ghl_provider_event_receipts
       (event_key, event_type, state, claim_token, lease_expires_at, attempt_count, claimed_at,
        location_id, calendar_id, remote_event_id, appointment_id, ghl_contact_id, event_at)
     VALUES ($1, $2, 'claimed', $3, now() + ($4::int * interval '1 second'), 1, now(), $5, $6, $7, $8, $9, $10)
     ON CONFLICT (provider, event_key) DO UPDATE
       SET state = 'claimed', claim_token = EXCLUDED.claim_token, lease_expires_at = EXCLUDED.lease_expires_at,
           attempt_count = ghl_provider_event_receipts.attempt_count + 1,
           delivery_count = ghl_provider_event_receipts.delivery_count + 1,
           claimed_at = now(), last_error = NULL
       WHERE ghl_provider_event_receipts.state = 'failed'
          OR (ghl_provider_event_receipts.state IN ('received', 'claimed')
              AND COALESCE(ghl_provider_event_receipts.lease_expires_at, to_timestamp(0)) < now())
     RETURNING id, attempt_count`,
    [eventKey, eventType, claimToken, RECEIPT_LEASE_SECONDS, meta.locationId ?? null, meta.calendarId ?? null,
      meta.remoteEventId ?? null, meta.appointmentId ?? null, meta.ghlContactId ?? null, meta.eventAt ?? null]);
  if (claimed.rows[0]) {
    return { decision: "process", receiptId: claimed.rows[0].id, claimToken, attempt: Number(claimed.rows[0].attempt_count) };
  }
  const existing = await pool.query(
    `UPDATE ghl_provider_event_receipts SET delivery_count = delivery_count + 1
     WHERE provider = 'ghl' AND event_key = $1 RETURNING id, state`, [eventKey]);
  const row = existing.rows[0];
  if (!row) throw new Error("GHL_WEBHOOK_RECEIPT_STATE_UNREADABLE");
  return row.state === "applied"
    ? { decision: "duplicate_applied", receiptId: row.id }
    : { decision: "in_flight", receiptId: row.id };
}

/** Marks the outcome of a claimed receipt. Fenced by the claim token; returns false when the claim was lost. */
export async function markGhlWebhookReceipt(
  receiptId: string, claimToken: string, outcome: "applied" | "failed", error?: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE ghl_provider_event_receipts
     SET state = $3, claim_token = NULL, lease_expires_at = NULL,
         applied_at = CASE WHEN $3 = 'applied' THEN now() ELSE applied_at END,
         failed_at = CASE WHEN $3 = 'failed' THEN now() ELSE failed_at END,
         last_error = $4
     WHERE id = $1 AND claim_token = $2 AND state = 'claimed'`,
    [receiptId, claimToken, outcome, error ? error.slice(0, 300) : null]);
  return (result.rowCount ?? 0) === 1;
}

type RawRequest = Request & { rawBody?: Buffer };

function rawBodyOf(req: RawRequest): string {
  return req.rawBody && Buffer.isBuffer(req.rawBody) ? req.rawBody.toString("utf8") : JSON.stringify(req.body);
}

/**
 * Express middleware mounted after signature verification. The acknowledgement is held until the
 * receipt outcome is durable: res.end is wrapped so the status code decides applied/failed first.
 */
export function ghlWebhookReceiptMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const eventType = req.path.replace(/^\//, "").replace(/\//g, "-") || "unknown";
    let claim: ReceiptClaim;
    try {
      claim = await claimGhlWebhookReceipt(ghlWebhookEventKey(eventType, rawBodyOf(req as RawRequest)), eventType, extractReceiptMeta(req.body));
    } catch (error) {
      console.error("[GHL Webhook] Receipt storage failed — refusing so the sender retries:", (error as Error).message);
      return res.status(503).json({ received: false, error: "receipt_unavailable" });
    }
    if (claim.decision === "duplicate_applied") return res.json({ received: true, duplicate: true });
    if (claim.decision === "in_flight") return res.status(409).json({ received: false, error: "delivery_in_progress" });

    const originalEnd = res.end.bind(res) as (...args: any[]) => Response;
    let ended = false;
    (res as any).end = (...args: any[]) => {
      if (ended) return res;
      ended = true;
      const ok = res.statusCode < 400;
      markGhlWebhookReceipt(claim.receiptId, claim.claimToken, ok ? "applied" : "failed", ok ? undefined : `http_${res.statusCode}`)
        .then(held => (held ? null : { status: 409, error: "receipt_claim_lost" }))
        .catch(error => {
          console.error("[GHL Webhook] Could not persist receipt outcome:", (error as Error).message);
          return { status: 503, error: "receipt_unavailable" };
        })
        .then(override => {
          // Never acknowledge success unless the receipt outcome is durable.
          if (override && ok) {
            res.statusCode = override.status;
            res.removeHeader("Content-Length");
            res.setHeader("Content-Type", "application/json");
            originalEnd(JSON.stringify({ received: false, error: override.error }));
          } else {
            originalEnd(...args);
          }
        });
      return res;
    };
    next();
  };
}
