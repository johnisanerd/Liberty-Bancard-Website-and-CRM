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
 *
 * Identity of an occurrence is NOT the raw request bytes: a verified provider event id, else a semantic key built
 * from stable ids and the event time, else the canonical (key-sorted) payload fingerprint. Re-serialized or
 * re-delivered copies of one event therefore map to one receipt, while a different payload under a reused semantic
 * key becomes a distinct occurrence.
 *
 * Effect recovery: the moment a handler responds successfully, `effect_applied_at` is made durable BEFORE the
 * acknowledgement and the final receipt settlement. If settlement then fails, the sender's retry re-claims the
 * receipt, sees the effect already applied, and completes it without running the handler again.
 */
import { createHash, randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { pool } from "../db";

export const RECEIPT_LEASE_SECONDS = 120;

export type ReceiptClaim =
  | { decision: "process"; receiptId: string; claimToken: string; attempt: number; effectApplied: boolean }
  | { decision: "duplicate_applied"; receiptId: string }
  | { decision: "in_flight"; receiptId: string };

export interface ReceiptMeta {
  locationId?: string | null;
  calendarId?: string | null;
  remoteEventId?: string | null;
  appointmentId?: string | null;
  ghlContactId?: string | null;
  eventAt?: Date | null;
  payloadFingerprint?: string | null;
}

/** Key-sorted JSON so formatting, key order and whitespace never change an occurrence's identity. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function ghlPayloadFingerprint(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

export interface GhlOccurrenceIdentity { eventKey: string; fingerprint: string; basis: "provider_event_id" | "semantic" | "payload_fingerprint" }

/**
 * Stable occurrence identity. The body has already passed signature verification, so a provider event id inside it
 * is verified. A bare `id` is NOT treated as an event id (for contact events it is the contact id).
 */
export function ghlWebhookOccurrence(eventType: string, body: unknown): GhlOccurrenceIdentity {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, any>;
  const appointment = (b.appointment && typeof b.appointment === "object" ? b.appointment : {}) as Record<string, any>;
  const fingerprint = ghlPayloadFingerprint(body);
  const text = (v: unknown) => (typeof v === "string" && v.trim().length > 0 ? v.trim().slice(0, 200) : null);
  const providerEventId = text(b.webhookId) ?? text(b.eventId);
  if (providerEventId) return { eventKey: `${eventType}:evt:${providerEventId}`, fingerprint, basis: "provider_event_id" };
  const rawTime = b.dateUpdated ?? b.dateAdded ?? b.timestamp ?? appointment.dateUpdated ?? appointment.dateAdded
    ?? b.startTime ?? appointment.startTime;
  const when = rawTime ? new Date(rawTime) : null;
  const whenIso = when && !Number.isNaN(when.getTime()) ? when.toISOString() : null;
  const subject = text(b.messageId) ?? text(b.callId) ?? text(b.appointmentId) ?? text(appointment.id)
    ?? text(b.contactId) ?? text(appointment.contactId);
  if (subject && whenIso) {
    const status = text(b.status) ?? text(appointment.appointmentStatus) ?? text(b.appointmentStatus) ?? "";
    return { eventKey: `${eventType}:sem:${subject}:${status}:${whenIso}`, fingerprint, basis: "semantic" };
  }
  return { eventKey: `${eventType}:fp:${fingerprint}`, fingerprint, basis: "payload_fingerprint" };
}

/** Compatibility wrapper: derives the stable occurrence key from a raw JSON body (never a raw-byte hash). */
export function ghlWebhookEventKey(eventType: string, rawBody: string): string {
  let body: unknown;
  try { body = JSON.parse(rawBody); } catch { body = rawBody; }
  return ghlWebhookOccurrence(eventType, body).eventKey;
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
        location_id, calendar_id, remote_event_id, appointment_id, ghl_contact_id, event_at, payload_fingerprint)
     VALUES ($1, $2, 'claimed', $3, now() + ($4::int * interval '1 second'), 1, now(), $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (provider, event_key) DO UPDATE
       SET state = 'claimed', claim_token = EXCLUDED.claim_token, lease_expires_at = EXCLUDED.lease_expires_at,
           attempt_count = ghl_provider_event_receipts.attempt_count + 1,
           delivery_count = ghl_provider_event_receipts.delivery_count + 1,
           claimed_at = now(), last_error = NULL
       WHERE ghl_provider_event_receipts.state = 'failed'
          OR (ghl_provider_event_receipts.state IN ('received', 'claimed')
              AND COALESCE(ghl_provider_event_receipts.lease_expires_at, to_timestamp(0)) < now())
     RETURNING id, attempt_count, effect_applied_at`,
    [eventKey, eventType, claimToken, RECEIPT_LEASE_SECONDS, meta.locationId ?? null, meta.calendarId ?? null,
      meta.remoteEventId ?? null, meta.appointmentId ?? null, meta.ghlContactId ?? null, meta.eventAt ?? null,
      meta.payloadFingerprint ?? null]);
  if (claimed.rows[0]) {
    return {
      decision: "process", receiptId: claimed.rows[0].id, claimToken, attempt: Number(claimed.rows[0].attempt_count),
      effectApplied: claimed.rows[0].effect_applied_at != null,
    };
  }
  const existing = await pool.query(
    `UPDATE ghl_provider_event_receipts SET delivery_count = delivery_count + 1
     WHERE provider = 'ghl' AND event_key = $1 RETURNING id, state, payload_fingerprint`, [eventKey]);
  const row = existing.rows[0];
  if (!row) throw new Error("GHL_WEBHOOK_RECEIPT_STATE_UNREADABLE");
  // A semantic or event-id key reused with a different payload is a different occurrence, not a duplicate.
  if (meta.payloadFingerprint && row.payload_fingerprint && row.payload_fingerprint !== meta.payloadFingerprint
      && !eventKey.includes(":fp:")) {
    return claimGhlWebhookReceipt(`${eventKey}:fp:${meta.payloadFingerprint.slice(0, 24)}`, eventType, meta);
  }
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

/** Durable record that the handler's effects were applied. Fenced by the claim token. */
export async function markGhlWebhookEffectApplied(receiptId: string, claimToken: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE ghl_provider_event_receipts SET effect_applied_at = COALESCE(effect_applied_at, now())
     WHERE id = $1 AND claim_token = $2 AND state = 'claimed'`, [receiptId, claimToken]);
  return (result.rowCount ?? 0) === 1;
}

type RawRequest = Request & { rawBody?: Buffer };

/**
 * Express middleware mounted after signature verification. The acknowledgement is held until the
 * receipt outcome is durable: res.end is wrapped so the status code decides applied/failed first.
 */
export function ghlWebhookReceiptMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const eventType = req.path.replace(/^\//, "").replace(/\//g, "-") || "unknown";
    let claim: ReceiptClaim;
    try {
      const occurrence = ghlWebhookOccurrence(eventType, req.body);
      claim = await claimGhlWebhookReceipt(occurrence.eventKey, eventType,
        { ...extractReceiptMeta(req.body), payloadFingerprint: occurrence.fingerprint });
    } catch (error) {
      console.error("[GHL Webhook] Receipt storage failed — refusing so the sender retries:", (error as Error).message);
      return res.status(503).json({ received: false, error: "receipt_unavailable" });
    }
    if (claim.decision === "duplicate_applied") return res.json({ received: true, duplicate: true });
    if (claim.decision === "in_flight") return res.status(409).json({ received: false, error: "delivery_in_progress" });

    if (claim.effectApplied) {
      // The handler already ran to completion on an earlier delivery; only the settlement was lost. Complete it
      // without re-running any effect.
      try {
        const held = await markGhlWebhookReceipt(claim.receiptId, claim.claimToken, "applied");
        if (!held) return res.status(409).json({ received: false, error: "receipt_claim_lost" });
      } catch (error) {
        console.error("[GHL Webhook] Could not settle recovered receipt:", (error as Error).message);
        return res.status(503).json({ received: false, error: "receipt_unavailable" });
      }
      return res.json({ received: true, recovered: true });
    }

    // Make the effect durable before the acknowledgement: wrap send so a successful response first records it.
    const originalSend = res.send.bind(res) as (...args: any[]) => Response;
    let effectMarked = false;
    (res as any).send = (...args: any[]) => {
      if (effectMarked || res.statusCode >= 400) return originalSend(...args);
      effectMarked = true;
      markGhlWebhookEffectApplied(claim.receiptId, claim.claimToken)
        .then(held => {
          if (!held) { res.statusCode = 409; return originalSend(JSON.stringify({ received: false, error: "receipt_claim_lost" })); }
          return originalSend(...args);
        })
        .catch(error => {
          console.error("[GHL Webhook] Could not persist effect marker:", (error as Error).message);
          res.statusCode = 503;
          return originalSend(JSON.stringify({ received: false, error: "receipt_unavailable" }));
        });
      return res;
    };

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
