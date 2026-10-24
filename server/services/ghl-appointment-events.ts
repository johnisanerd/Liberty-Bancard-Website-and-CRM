/**
 * GHL appointment lifecycle ordering (#2105 C6).
 *
 * Appointment updated/rescheduled events are recorded against ghl_appointment_state with event-time
 * ordering. They never enroll workflows, tag contacts, or change lead stage: those chains belong to
 * the booked/canceled handlers and must not fire twice for one appointment.
 *
 * Ordering rules (all enforced in one conditional upsert):
 *  - an older event never overwrites a newer one;
 *  - canceled and showed are terminal; late update/reschedule events cannot revive or regress them
 *    (a re-book in GHL creates a new appointment id);
 *  - booked never overwrites an existing row.
 */
import { pool } from "../db";

export type AppointmentEventKind = "booked" | "updated" | "rescheduled" | "showed" | "canceled";

export interface AppointmentEventInput {
  kind: AppointmentEventKind;
  payload: Record<string, unknown>;
  receiptId?: string | null;
  /** Locations/calendars this deployment is configured for. Empty calendars = no calendar restriction. */
  allowedLocationId?: string | null;
  allowedCalendarIds?: string[];
}

export type AppointmentRejectReason =
  | "missing_identity" | "location_mismatch" | "location_missing" | "calendar_not_configured" | "calendar_missing"
  | "missing_event_time";

export type AppointmentDecision =
  | { decision: "apply" }
  | { decision: "replay" | "stale" | "terminal" }
  | { decision: "rejected"; reason: AppointmentRejectReason };

export type AppointmentEventResult = {
  applied: boolean;
  reason: "applied" | "stale" | "terminal" | "replay" | AppointmentRejectReason;
};

function text(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function time(v: unknown): Date | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function configuredAppointmentCalendarIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return [env.GHL_APPOINTMENT_CALENDAR_ID, env.GHL_DEFAULT_CALENDAR_ID, env.GHL_CALENDAR_ID]
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

interface NormalizedAppointmentEvent {
  appointmentId: string; contactId: string | null; calendarId: string | null; locationId: string | null;
  eventAt: Date; startTime: Date | null; endTime: Date | null;
}

/** Validation shared by the pre-handler decision and the recorder. Nothing here defaults a missing fact. */
function normalizeAppointmentEvent(input: AppointmentEventInput): NormalizedAppointmentEvent | { rejected: AppointmentRejectReason } {
  const p = input.payload;
  const appointment = (p.appointment && typeof p.appointment === "object" ? p.appointment : {}) as Record<string, unknown>;
  const appointmentId = text(p.appointmentId) ?? text(appointment.id) ?? text(p.id);
  if (!appointmentId) return { rejected: "missing_identity" };

  // When allowed values are configured, an event that does not say where it came from is not trusted.
  const locationId = text(p.locationId) ?? text(appointment.locationId);
  if (input.allowedLocationId) {
    if (!locationId) return { rejected: "location_missing" };
    if (locationId !== input.allowedLocationId) return { rejected: "location_mismatch" };
  }
  const calendarId = text(p.calendarId) ?? text(appointment.calendarId);
  const allowedCalendars = input.allowedCalendarIds ?? [];
  if (allowedCalendars.length > 0) {
    if (!calendarId) return { rejected: "calendar_missing" };
    if (!allowedCalendars.includes(calendarId)) return { rejected: "calendar_not_configured" };
  }

  // Ordering needs the provider's event time. Arrival time is not an event time.
  const eventAt = time(p.dateUpdated) ?? time(p.dateAdded) ?? time(p.timestamp)
    ?? time(appointment.dateUpdated) ?? time(appointment.dateAdded);
  if (!eventAt) return { rejected: "missing_event_time" };
  return {
    appointmentId, contactId: text(p.contactId) ?? text(appointment.contactId), calendarId, locationId, eventAt,
    startTime: time(p.startTime) ?? time(appointment.startTime),
    endTime: time(p.endTime) ?? time(appointment.endTime),
  };
}

const TERMINAL_STATUSES = ["showed", "canceled"];

/**
 * Read-only ordering decision, evaluated BEFORE any booked/showed/canceled handler runs so a stale, terminal or
 * replayed event never enrolls, tags, moves a lead stage or sends anything. `apply` means the handler may run and
 * the event should then be recorded; `replay` means this exact event was already recorded.
 */
export async function decideGhlAppointmentEvent(input: AppointmentEventInput): Promise<AppointmentDecision> {
  const event = normalizeAppointmentEvent(input);
  if ("rejected" in event) return { decision: "rejected", reason: event.rejected };
  const existing = (await pool.query(
    `SELECT status, last_event_at FROM ghl_appointment_state WHERE appointment_id = $1`, [event.appointmentId])).rows[0];
  if (!existing) return { decision: "apply" };
  const sameInstant = new Date(existing.last_event_at).getTime() === event.eventAt.getTime();
  if (input.kind === "booked") {
    if (TERMINAL_STATUSES.includes(existing.status)) return { decision: "terminal" };
    // A booked event that arrives after an update still owns its one-time handler; the recorder keeps the state.
    return existing.status === "booked" ? { decision: "replay" } : { decision: "apply" };
  }
  if (TERMINAL_STATUSES.includes(existing.status)) {
    return existing.status === input.kind && sameInstant ? { decision: "replay" } : { decision: "terminal" };
  }
  if (sameInstant && existing.status === input.kind) return { decision: "replay" };
  return new Date(existing.last_event_at).getTime() < event.eventAt.getTime() ? { decision: "apply" } : { decision: "stale" };
}

export async function recordGhlAppointmentEvent(input: AppointmentEventInput): Promise<AppointmentEventResult> {
  const event = normalizeAppointmentEvent(input);
  if ("rejected" in event) return { applied: false, reason: event.rejected };
  const { appointmentId, calendarId, locationId, eventAt, startTime, endTime } = event;
  const status = input.kind;

  const result = await pool.query(
    `INSERT INTO ghl_appointment_state
       (appointment_id, ghl_contact_id, calendar_id, location_id, status, start_time, end_time, last_event_at, last_receipt_id, reschedule_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $5 = 'rescheduled' THEN 1 ELSE 0 END)
     ON CONFLICT (appointment_id) DO UPDATE
       SET status = EXCLUDED.status,
           ghl_contact_id = COALESCE(EXCLUDED.ghl_contact_id, ghl_appointment_state.ghl_contact_id),
           calendar_id = COALESCE(EXCLUDED.calendar_id, ghl_appointment_state.calendar_id),
           location_id = COALESCE(EXCLUDED.location_id, ghl_appointment_state.location_id),
           start_time = COALESCE(EXCLUDED.start_time, ghl_appointment_state.start_time),
           end_time = COALESCE(EXCLUDED.end_time, ghl_appointment_state.end_time),
           last_event_at = EXCLUDED.last_event_at,
           last_receipt_id = EXCLUDED.last_receipt_id,
           reschedule_count = ghl_appointment_state.reschedule_count
             + CASE WHEN EXCLUDED.status = 'rescheduled' THEN 1 ELSE 0 END,
           updated_at = now()
       WHERE EXCLUDED.status <> 'booked'
         AND ghl_appointment_state.last_event_at < EXCLUDED.last_event_at
         AND ghl_appointment_state.status NOT IN ('showed', 'canceled')
     RETURNING appointment_id`,
    [appointmentId, event.contactId, calendarId, locationId, status,
      startTime, endTime, eventAt, input.receiptId ?? null]);
  if (result.rows.length === 1) return { applied: true, reason: "applied" };

  const existing = (await pool.query(
    `SELECT status, last_event_at FROM ghl_appointment_state WHERE appointment_id = $1`, [appointmentId])).rows[0];
  if (existing && status !== "booked" && existing.status === status
      && new Date(existing.last_event_at).getTime() === eventAt.getTime()) return { applied: false, reason: "replay" };
  if (existing && status === "booked" && existing.status === "booked") return { applied: false, reason: "replay" };
  if (existing && TERMINAL_STATUSES.includes(existing.status) && status !== "booked") return { applied: false, reason: "terminal" };
  return { applied: false, reason: "stale" };
}
