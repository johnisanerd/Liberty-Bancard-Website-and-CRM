/**
 * GHL appointment lifecycle ordering (#2105 C6, H6).
 *
 * Appointment updated/rescheduled events are recorded against ghl_appointment_state with event-time
 * ordering. They never enroll workflows, tag contacts, or change lead stage: those chains belong to
 * the booked/canceled handlers and must not fire twice for one appointment.
 *
 * Every transition for one appointment is decided and recorded inside ONE transaction that holds a per-appointment
 * advisory lock, so two deliveries for the same appointment (book/cancel, update/cancel, duplicates) serialize and a
 * decision is never made against state another delivery is about to change.
 *
 * Ordering rules:
 *  - an older event never overwrites a newer one;
 *  - canceled and showed are terminal; late update/reschedule events cannot revive or regress them
 *    (a re-book in GHL creates a new appointment id);
 *  - the one-time booked effect has its own identity (booked_effect_receipt_id): a booked event that arrives after
 *    an update owns the booked effect exactly once without regressing the newer state, and a booked event that arrives
 *    after the effect was claimed is a replay;
 *  - an effect whose appointment was made terminal by a later accepted transition is superseded and does not run.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { runReceiptTxStep, currentReceiptId, type DbTx } from "./ghl-webhook-effects";

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

type Executor = Pick<DbTx, "execute">;

/** Serializes everything for one appointment id for the rest of the transaction. */
export async function lockGhlAppointment(tx: Executor, appointmentId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ghl_appointment:${appointmentId}`}, 0))`);
}

export function ghlAppointmentIdOf(payload: unknown): string | null {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const appointment = (p.appointment && typeof p.appointment === "object" ? p.appointment : {}) as Record<string, unknown>;
  return text(p.appointmentId) ?? text(appointment.id) ?? text(p.id);
}

interface StateRow { status: string; last_event_at: string | Date; booked_effect_receipt_id: string | null }

async function readState(tx: Executor, appointmentId: string): Promise<StateRow | undefined> {
  return (await tx.execute(sql`SELECT status, last_event_at, booked_effect_receipt_id
    FROM ghl_appointment_state WHERE appointment_id = ${appointmentId}`)).rows[0] as unknown as StateRow | undefined;
}

/**
 * Decides and (when `persist`) records one transition under the appointment lock. Returns `apply` only for the
 * delivery that owns the transition's effects. Booked owns the one-time booked effect; every other kind owns the
 * recorded state change.
 */
export async function transitionGhlAppointment(
  tx: Executor, input: AppointmentEventInput, persist: boolean,
): Promise<AppointmentDecision> {
  const event = normalizeAppointmentEvent(input);
  if ("rejected" in event) return { decision: "rejected", reason: event.rejected };
  const { appointmentId, calendarId, locationId, eventAt, startTime, endTime } = event;
  const kind = input.kind;
  const receiptId = input.receiptId ?? randomUUID();
  await lockGhlAppointment(tx, appointmentId);
  const existing = await readState(tx, appointmentId);

  if (!existing) {
    if (persist) {
      await tx.execute(sql`INSERT INTO ghl_appointment_state
        (appointment_id, ghl_contact_id, calendar_id, location_id, status, start_time, end_time, last_event_at,
         last_receipt_id, reschedule_count, booked_effect_receipt_id)
        VALUES (${appointmentId}, ${event.contactId}, ${calendarId}, ${locationId}, ${kind},
          ${startTime?.toISOString() ?? null}, ${endTime?.toISOString() ?? null}, ${eventAt.toISOString()},
          ${receiptId}::uuid, ${kind === "rescheduled" ? 1 : 0}, ${kind === "booked" ? receiptId : null}::uuid)`);
    }
    return { decision: "apply" };
  }

  const last = new Date(existing.last_event_at).getTime();
  const sameInstant = last === eventAt.getTime();
  const terminal = TERMINAL_STATUSES.includes(existing.status);

  if (kind === "booked") {
    if (terminal) return { decision: "terminal" };
    if (existing.booked_effect_receipt_id) return { decision: "replay" };
    if (persist) {
      // Own the one-time booked effect. The state only moves forward: an older booked event never regresses a
      // newer update.
      await tx.execute(sql`UPDATE ghl_appointment_state SET
          booked_effect_receipt_id = ${receiptId}::uuid,
          status = CASE WHEN last_event_at < ${eventAt.toISOString()}::timestamptz THEN 'booked' ELSE status END,
          last_event_at = GREATEST(last_event_at, ${eventAt.toISOString()}::timestamptz),
          last_receipt_id = CASE WHEN last_event_at < ${eventAt.toISOString()}::timestamptz THEN ${receiptId}::uuid ELSE last_receipt_id END,
          updated_at = now()
        WHERE appointment_id = ${appointmentId}`);
    }
    return { decision: "apply" };
  }

  if (terminal) return existing.status === kind && sameInstant ? { decision: "replay" } : { decision: "terminal" };
  if (sameInstant && existing.status === kind) return { decision: "replay" };
  if (last >= eventAt.getTime()) return { decision: "stale" };
  if (persist) {
    await tx.execute(sql`UPDATE ghl_appointment_state SET
        status = ${kind},
        ghl_contact_id = COALESCE(${event.contactId}, ghl_contact_id),
        calendar_id = COALESCE(${calendarId}, calendar_id),
        location_id = COALESCE(${locationId}, location_id),
        start_time = COALESCE(${startTime?.toISOString() ?? null}::timestamptz, start_time),
        end_time = COALESCE(${endTime?.toISOString() ?? null}::timestamptz, end_time),
        last_event_at = ${eventAt.toISOString()}::timestamptz,
        last_receipt_id = ${receiptId}::uuid,
        reschedule_count = reschedule_count + ${kind === "rescheduled" ? 1 : 0},
        updated_at = now()
      WHERE appointment_id = ${appointmentId}`);
  }
  return { decision: "apply" };
}

/**
 * True when a later accepted transition made this appointment terminal in a different way, so the earlier
 * transition's remaining effects must not run (a booked effect after a cancel, for example). Takes the appointment
 * lock when given a transaction so it serializes with the other transition's local effects.
 */
export async function ghlAppointmentSuperseded(
  tx: Executor | null, payload: unknown, kind: AppointmentEventKind,
): Promise<boolean> {
  const appointmentId = ghlAppointmentIdOf(payload);
  if (!appointmentId) return false;
  const run = async (executor: Executor) => {
    const row = await readState(executor, appointmentId);
    return !!row && TERMINAL_STATUSES.includes(row.status) && row.status !== kind;
  };
  if (tx) { await lockGhlAppointment(tx, appointmentId); return run(tx); }
  return run(db);
}

/** Read-only preview of the decision (rolled back). The authoritative decision is made by the recording transaction. */
export async function decideGhlAppointmentEvent(input: AppointmentEventInput): Promise<AppointmentDecision> {
  const rollback = new Error("preview_rollback");
  let verdict: AppointmentDecision = { decision: "stale" };
  try {
    await db.transaction(async tx => {
      verdict = await transitionGhlAppointment(tx, input, false);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  return verdict;
}

export async function recordGhlAppointmentEvent(input: AppointmentEventInput): Promise<AppointmentEventResult> {
  const verdict = await db.transaction(tx => transitionGhlAppointment(tx, input, true));
  if (verdict.decision === "apply") return { applied: true, reason: "applied" };
  if (verdict.decision === "rejected") return { applied: false, reason: verdict.reason };
  return { applied: false, reason: verdict.decision };
}

/**
 * Route entry point: decide and record the transition as the receipt's "transition" step (one transaction, one
 * appointment lock). A retry of the same delivery reuses the stored decision and never records it twice.
 */
export async function acceptGhlAppointmentTransition(input: AppointmentEventInput): Promise<AppointmentDecision> {
  const { result } = await runReceiptTxStep("transition", tx =>
    transitionGhlAppointment(tx, { ...input, receiptId: input.receiptId ?? currentReceiptId() }, true));
  return result;
}
