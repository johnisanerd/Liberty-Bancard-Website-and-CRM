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

export type AppointmentEventResult = {
  applied: boolean;
  reason: "applied" | "stale" | "terminal" | "missing_identity" | "location_mismatch" | "calendar_not_configured";
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

export async function recordGhlAppointmentEvent(input: AppointmentEventInput): Promise<AppointmentEventResult> {
  const p = input.payload;
  const appointment = (p.appointment && typeof p.appointment === "object" ? p.appointment : {}) as Record<string, unknown>;
  const appointmentId = text(p.appointmentId) ?? text(appointment.id) ?? text(p.id);
  if (!appointmentId) return { applied: false, reason: "missing_identity" };

  const locationId = text(p.locationId) ?? text(appointment.locationId);
  if (input.allowedLocationId && locationId && locationId !== input.allowedLocationId) {
    return { applied: false, reason: "location_mismatch" };
  }
  const calendarId = text(p.calendarId) ?? text(appointment.calendarId);
  const allowedCalendars = input.allowedCalendarIds ?? [];
  if (calendarId && allowedCalendars.length > 0 && !allowedCalendars.includes(calendarId)) {
    return { applied: false, reason: "calendar_not_configured" };
  }

  const eventAt = time(p.dateUpdated) ?? time(p.dateAdded) ?? time(p.timestamp) ?? time(appointment.dateUpdated) ?? new Date();
  const startTime = time(p.startTime) ?? time(appointment.startTime);
  const endTime = time(p.endTime) ?? time(appointment.endTime);
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
    [appointmentId, text(p.contactId) ?? text(appointment.contactId), calendarId, locationId, status,
      startTime, endTime, eventAt, input.receiptId ?? null]);
  if (result.rows.length === 1) return { applied: true, reason: "applied" };

  const existing = (await pool.query(
    `SELECT status, last_event_at FROM ghl_appointment_state WHERE appointment_id = $1`, [appointmentId])).rows[0];
  if (existing && ["showed", "canceled"].includes(existing.status) && status !== "booked") return { applied: false, reason: "terminal" };
  return { applied: false, reason: "stale" };
}
