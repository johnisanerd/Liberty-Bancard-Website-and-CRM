import { db } from "../../db";
import { sdrLeadState, sdrLeadEvents, sdrMerchants, sdrChannelAttempts } from "@shared/schema";
import type { SdrMerchant } from "@shared/schema";
import { eq } from "drizzle-orm";
import { fetchCalendars, isSdrGhlConfigured } from "./ghl-client";
import { onStageChange } from "./ghl-sync-rules";
import { runReceiptStep, runReceiptTxStep, type DbTx } from "../ghl-webhook-effects";
import { ghlAppointmentSuperseded } from "../ghl-appointment-events";

async function enrollMerchantWorkflow(
  merchant: Pick<SdrMerchant, "id" | "ghlContactId">,
  workflowKey: string,
  metadata?: Record<string, unknown>,
) {
  if (!merchant.ghlContactId) return { success: false, error: "No GHL contact ID", skipped: true };
  const { enrollInGhlWorkflowCompliant, resolveLocalContactIdForGhlContactId } = await import("../ghl-workflows");
  const contactId = await resolveLocalContactIdForGhlContactId(merchant.ghlContactId);
  if (!contactId) return { success: false, error: "No unique local contact mapped to this SDR merchant", skipped: true };
  return enrollInGhlWorkflowCompliant({ workflowKey, ghlContactId: merchant.ghlContactId, contactId, metadata });
}

const VERTICAL_CALENDAR_KEY_MAP: Record<string, { envVar: string; calendarKey: string }> = {
  "Medical/Dental/Medspa": { envVar: "GHL_CALENDAR_MEDICAL",     calendarKey: "MEDICAL" },
  "Healthcare":            { envVar: "GHL_CALENDAR_MEDICAL",     calendarKey: "MEDICAL" },
  "Medical":               { envVar: "GHL_CALENDAR_MEDICAL",     calendarKey: "MEDICAL" },
  "Dental":                { envVar: "GHL_CALENDAR_DENTAL",      calendarKey: "DENTAL" },
  "Med Spa":               { envVar: "GHL_CALENDAR_MEDSPA",      calendarKey: "MEDSPA" },
  "Medspa":                { envVar: "GHL_CALENDAR_MEDSPA",      calendarKey: "MEDSPA" },
  "Automotive":            { envVar: "GHL_CALENDAR_AUTO",        calendarKey: "AUTO" },
  "Auto":                  { envVar: "GHL_CALENDAR_AUTO",        calendarKey: "AUTO" },
  "Auto Repair":           { envVar: "GHL_CALENDAR_AUTO",        calendarKey: "AUTO" },
  "Restaurant":            { envVar: "GHL_CALENDAR_RESTAURANT",  calendarKey: "RESTAURANT" },
  "Home Services":         { envVar: "GHL_CALENDAR_HOME",        calendarKey: "HOME" },
  "Retail":                { envVar: "GHL_CALENDAR_RETAIL",      calendarKey: "RETAIL" },
  "Salon/Spa":             { envVar: "GHL_CALENDAR_SALON",       calendarKey: "SALON" },
  "Salon":                 { envVar: "GHL_CALENDAR_SALON",       calendarKey: "SALON" },
  "Gym":                   { envVar: "GHL_CALENDAR_GYM",         calendarKey: "GYM" },
  "Fitness":               { envVar: "GHL_CALENDAR_GYM",         calendarKey: "GYM" },
  "Fitness/Recreation":    { envVar: "GHL_CALENDAR_GYM",         calendarKey: "GYM" },
  "Hotel":                 { envVar: "GHL_CALENDAR_HOTEL",       calendarKey: "HOTEL" },
  "Hospitality":           { envVar: "GHL_CALENDAR_HOTEL",       calendarKey: "HOTEL" },
  "Landscaping":           { envVar: "GHL_CALENDAR_LANDSCAPING", calendarKey: "LANDSCAPING" },
  "Construction":          { envVar: "GHL_CALENDAR_CONSTRUCTION",calendarKey: "CONSTRUCTION" },
  "Legal":                 { envVar: "GHL_CALENDAR_LEGAL",       calendarKey: "LEGAL" },
  "Professional Services": { envVar: "GHL_CALENDAR_LEGAL",       calendarKey: "LEGAL" },
};

function normalizeVerticalForCalendar(vertical: string): string {
  const v = vertical.toLowerCase().trim();
  if (/^auto$|automotive|auto repair|collision|body shop|tire/i.test(v)) return "Automotive";
  if (/med.?spa|medspa/i.test(v)) return "Med Spa";
  if (/dental|dentist/i.test(v)) return "Dental";
  if (/medical|healthcare|clinic|health/i.test(v)) return "Medical/Dental/Medspa";
  if (/salon|spa|hair|nail|barber|beauty/i.test(v)) return "Salon/Spa";
  if (/gym|fitness|yoga|pilates|crossfit|martial arts|wellness/i.test(v)) return "Gym";
  if (/hotel|motel|lodge|resort|hospitality|inn/i.test(v)) return "Hotel";
  if (/landscap|lawn|tree service|grounds|irrigation/i.test(v)) return "Landscaping";
  if (/construct|contractor|builder|roofer|plumb|electrician|hvac|remodel/i.test(v)) return "Construction";
  if (/attorney|law firm|lawyer|legal|solicitor|paralegal/i.test(v)) return "Legal";
  if (/restaurant|food|cafe|bakery|diner|bistro/i.test(v)) return "Restaurant";
  if (/retail|shop|store|boutique/i.test(v)) return "Retail";
  if (/home service|handyman|cleaning|maid|janitorial/i.test(v)) return "Home Services";
  return vertical;
}

function getVerticalCalendarMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [key, { envVar }] of Object.entries(VERTICAL_CALENDAR_KEY_MAP)) {
    map[key] = process.env[envVar] || "";
  }
  return map;
}

function requireCalendarId(vertical: string): string {
  const normalized = normalizeVerticalForCalendar(vertical);
  const entry = VERTICAL_CALENDAR_KEY_MAP[normalized] || VERTICAL_CALENDAR_KEY_MAP[vertical];
  if (!entry) {
    throw new Error(`No calendar configuration found for vertical "${vertical}". Add it to VERTICAL_CALENDAR_KEY_MAP.`);
  }
  const calendarId = process.env[entry.envVar] || "";
  if (!calendarId) {
    throw new Error(`Calendar not configured for vertical "${vertical}". Set the ${entry.envVar} environment variable.`);
  }
  return calendarId;
}

export interface CalendarSelection {
  calendarId: string;
  calendarName: string;
  reason: string;
}

export async function decideBestCalendar(merchant: SdrMerchant): Promise<CalendarSelection | null> {
  if (!isSdrGhlConfigured()) return null;

  if (merchant.vertical) {
    const normalized = normalizeVerticalForCalendar(merchant.vertical);
    const entry = VERTICAL_CALENDAR_KEY_MAP[normalized] || VERTICAL_CALENDAR_KEY_MAP[merchant.vertical];
    const calendarId = entry ? (process.env[entry.envVar] || "") : "";
    if (calendarId) {
      return {
        calendarId,
        calendarName: `${normalized} Calendar`,
        reason: `Matched by vertical: ${merchant.vertical} → ${normalized}`,
      };
    }
  }

  const defaultCalendarId = process.env.GHL_DEFAULT_CALENDAR_ID;
  if (defaultCalendarId) {
    return {
      calendarId: defaultCalendarId,
      calendarName: "Default Calendar",
      reason: "Default calendar (no vertical-specific calendar configured)",
    };
  }

  try {
    const calendars = await fetchCalendars();
    if (calendars.length > 0) {
      return {
        calendarId: calendars[0].id,
        calendarName: calendars[0].name,
        reason: "First available calendar from GHL",
      };
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[Scheduling] Failed to fetch calendars:", errMsg);
  }

  return null;
}

export interface BookingLinkResult {
  sent: boolean;
  bookingUrl?: string;
  channel?: string;
  reason?: string;
}

export async function sendBookingLink(
  merchantId: number,
  channel: "sms" | "email" | "chat" = "sms"
): Promise<BookingLinkResult> {
  const [merchant] = await db.select().from(sdrMerchants).where(eq(sdrMerchants.id, merchantId));
  if (!merchant) {
    return { sent: false, reason: "Merchant not found" };
  }

  const { checkAndLogCompliance } = await import("./compliance-engine");
  const complianceChannel = channel === "chat" ? "sms" : channel;
  const complianceResult = await checkAndLogCompliance(merchantId, complianceChannel as "sms" | "email");
  if (!complianceResult.allowed) {
    if (complianceResult.nextValidWindow) {
      await db.update(sdrLeadState).set({
        nextAction: "send_booking_link",
        nextActionType: "booking",
        nextActionAt: complianceResult.nextValidWindow,
        nextActionPayload: { channel },
        updatedAt: new Date(),
      }).where(eq(sdrLeadState.merchantId, merchantId));
      return { sent: false, reason: `Deferred: ${complianceResult.reason}. Queued for ${complianceResult.nextValidWindow.toISOString()}` };
    }
    return { sent: false, reason: complianceResult.reason };
  }

  const calendar = await decideBestCalendar(merchant);
  if (!calendar) {
    return { sent: false, reason: "No calendar available" };
  }

  const locationId = process.env.GHL_LOCATION_ID || "";
  const bookingUrl = `https://api.leadconnectorhq.com/widget/booking/${calendar.calendarId}`;

  if (!isSdrGhlConfigured() || !merchant.ghlContactId) {
    const reason = !isSdrGhlConfigured() ? "GHL not configured" : "No GHL contact ID";
    await db.insert(sdrLeadEvents).values({
      merchantId,
      eventType: "booking_link_queued",
      channel,
      actorType: "system",
      payloadJson: { bookingUrl, calendarId: calendar.calendarId, reason: `${reason} — link generated but not sent` },
      decisionReason: `Booking link generated but ${reason}`,
    });
    return { sent: false, bookingUrl, reason: `${reason} — link generated but not sent` };
  }

  try {
    const enrollment = await enrollMerchantWorkflow(merchant, "booking_link", {
      calendarId: calendar.calendarId, bookingUrl, calendarName: calendar.calendarName, channel,
    });
    if (!enrollment.success) return { sent: false, bookingUrl, reason: enrollment.error || "Booking link workflow was suppressed" };

    await db.insert(sdrChannelAttempts).values({
      merchantId,
      channel,
      attemptNo: 1,
      templateId: "booking_link",
      sentAt: new Date(),
      outcome: "sent",
    });

    await db.insert(sdrLeadEvents).values({
      merchantId,
      eventType: "booking_link_sent",
      channel,
      actorType: "system",
      payloadJson: {
        bookingUrl,
        calendarId: calendar.calendarId,
        calendarName: calendar.calendarName,
        selectionReason: calendar.reason,
      },
      decisionReason: `Booking link sent via ${channel}: ${calendar.calendarName}`,
    });

    console.log(`[Scheduling] Booking link sent for merchant ${merchantId} via ${channel}`);
    return { sent: true, bookingUrl, channel };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Scheduling] Failed to send booking link for merchant ${merchantId}:`, errMsg);

    await db.insert(sdrLeadEvents).values({
      merchantId,
      eventType: "booking_link_failed",
      channel,
      actorType: "system",
      payloadJson: { error: errMsg },
      decisionReason: `Failed to send booking link: ${errMsg}`,
    });

    return { sent: false, bookingUrl, reason: errMsg };
  }
}

type AppointmentWebhookData = {
  contactId?: string;
  appointmentId?: string;
  id?: string;
  calendarId?: string;
  status?: string;
  startTime?: string;
  [key: string]: unknown;
};

/**
 * Provider enrollment through the compliant helper. A structured refusal ({success:false, skipped:true}: pause,
 * unmapped contact, consent) is not an error to retry, but it is never silent: it is recorded as a visible lead event
 * on the merchant and returned as the step result. A real failure throws so the receipt is retried.
 */
async function enrollStep(
  stepKey: string, merchant: Pick<SdrMerchant, "id" | "ghlContactId">, workflowKey: string, metadata: Record<string, unknown>,
) {
  return runReceiptStep(stepKey, async () => {
    const result = await enrollMerchantWorkflow(merchant, workflowKey, metadata);
    const outcome = result as { success?: boolean; skipped?: boolean; error?: string };
    if (outcome.success === false && !outcome.skipped) {
      throw new Error(`workflow_enrollment_failed:${workflowKey}:${String(outcome.error ?? "unknown").slice(0, 120)}`);
    }
    if (outcome.success === false && outcome.skipped) {
      await db.insert(sdrLeadEvents).values({
        merchantId: merchant.id, eventType: "workflow_enrollment_held", channel: "system", actorType: "system",
        payloadJson: { workflowKey, reason: String(outcome.error ?? "skipped").slice(0, 200), stepKey },
        decisionReason: `Workflow ${workflowKey} not enrolled: ${String(outcome.error ?? "skipped").slice(0, 120)}`,
      });
      return { enrolled: false, held: true };
    }
    return { enrolled: true, held: false };
  });
}

/** Orphan (no matching merchant) appointment event is recorded locally and ends the handler. */
async function recordOrphanAppointmentEvent(tx: DbTx, eventType: string, webhookData: AppointmentWebhookData, ghlContactId: string) {
  await tx.insert(sdrLeadEvents).values({
    merchantId: null, eventType, channel: "calendar", actorType: "merchant", payloadJson: webhookData,
    ghlRefId: webhookData.appointmentId || ghlContactId,
  });
}

export async function handleAppointmentBooked(webhookData: AppointmentWebhookData): Promise<void> {
  const ghlContactId = webhookData.contactId;
  if (!ghlContactId) return;

  // Local effects commit together with their step record, under the appointment lock, unless a later accepted
  // transition (cancel/showed) already superseded this booked effect.
  const { result: local } = await runReceiptTxStep("booked:local", async tx => {
    if (await ghlAppointmentSuperseded(tx, webhookData, "booked")) return { outcome: "superseded" as const };
    const [merchant] = await tx.select().from(sdrMerchants).where(eq(sdrMerchants.ghlContactId, ghlContactId));
    if (!merchant) {
      await recordOrphanAppointmentEvent(tx, "appointment_booked", webhookData, ghlContactId);
      return { outcome: "orphan" as const };
    }
    const meetingId = webhookData.appointmentId || webhookData.id || null;
    const [state] = await tx.select().from(sdrLeadState).where(eq(sdrLeadState.merchantId, merchant.id));
    const oldStage = state?.currentStage ?? null;
    const nextActionPayload = { appointmentId: meetingId, startTime: webhookData.startTime, outreachPaused: true };
    if (state) {
      await tx.update(sdrLeadState).set({
        currentStage: "MEETING_SET", meetingId, lastTouchAt: new Date(), nextAction: "send_appointment_reminder",
        nextActionType: "reminder", nextActionPayload, updatedAt: new Date(),
      }).where(eq(sdrLeadState.merchantId, merchant.id));
    } else {
      await tx.insert(sdrLeadState).values({
        merchantId: merchant.id, currentStage: "MEETING_SET", meetingId, nextAction: "send_appointment_reminder",
        nextActionType: "reminder", nextActionPayload,
      });
    }
    await tx.insert(sdrLeadEvents).values({
      merchantId: merchant.id, eventType: "appointment_booked", channel: "calendar", actorType: "merchant",
      payloadJson: webhookData, ghlRefId: meetingId,
      decisionReason: `Appointment booked — advanced to MEETING_SET from ${oldStage || "unknown"}`,
    });
    return { outcome: "applied" as const, merchantId: merchant.id, oldStage, meetingId };
  });
  if (local.outcome !== "applied") return;

  const merchant = { id: local.merchantId, ghlContactId };
  const { upsertOutreachPause } = await import("./compliance-engine");
  await runReceiptStep("booked:outreach_pause", () => upsertOutreachPause(local.merchantId, true, "Outreach paused — appointment booked"));
  if (local.oldStage !== "MEETING_SET") {
    await runReceiptStep("booked:stage_sync", () => onStageChange(local.merchantId, "MEETING_SET", local.oldStage ?? undefined));
  }
  if (await ghlAppointmentSuperseded(null, webhookData, "booked")) return;
  // Awaited: a failed handoff fails the webhook receipt so the provider retry recovers it.
  await enrollStep("booked:enroll_booking_confirmation", merchant, "booking_confirmation",
    { meetingId: local.meetingId, startTime: webhookData.startTime });

  console.log(`[Scheduling] Appointment booked for merchant ${local.merchantId}: ${local.meetingId}`);
}

/**
 * #appointment-to-statement — When GHL fires an appointment-showed event,
 * advance the lead to STATEMENT_REQUESTED and enroll in the statement-request workflow.
 */
export async function handleAppointmentShowed(webhookData: AppointmentWebhookData): Promise<void> {
  const ghlContactId = webhookData.contactId;
  if (!ghlContactId) return;

  const { result: local } = await runReceiptTxStep("showed:local", async tx => {
    if (await ghlAppointmentSuperseded(tx, webhookData, "showed")) return { outcome: "superseded" as const };
    const [merchant] = await tx.select().from(sdrMerchants).where(eq(sdrMerchants.ghlContactId, ghlContactId));
    if (!merchant) {
      await recordOrphanAppointmentEvent(tx, "appointment_showed", webhookData, ghlContactId);
      return { outcome: "orphan" as const };
    }
    const meetingId = webhookData.appointmentId || webhookData.id || null;
    const [state] = await tx.select().from(sdrLeadState).where(eq(sdrLeadState.merchantId, merchant.id));
    const oldStage = state?.currentStage ?? null;
    if (state) {
      await tx.update(sdrLeadState).set({
        currentStage: "STATEMENT_REQUESTED", lastTouchAt: new Date(), nextAction: "statement_request_followup",
        nextActionType: "email", nextActionPayload: { meetingId, shownAt: webhookData.startTime }, updatedAt: new Date(),
      }).where(eq(sdrLeadState.merchantId, merchant.id));
    } else {
      await tx.insert(sdrLeadState).values({
        merchantId: merchant.id, currentStage: "STATEMENT_REQUESTED", meetingId,
        nextAction: "statement_request_followup", nextActionType: "email",
      });
    }
    await tx.insert(sdrLeadEvents).values({
      merchantId: merchant.id, eventType: "appointment_showed", channel: "calendar", actorType: "merchant",
      payloadJson: webhookData, ghlRefId: meetingId,
      decisionReason: `Appointment showed — advanced to STATEMENT_REQUESTED from ${oldStage || "unknown"}`,
    });
    return { outcome: "applied" as const, merchantId: merchant.id, oldStage, meetingId };
  });
  if (local.outcome !== "applied") return;

  if (local.oldStage !== "STATEMENT_REQUESTED") {
    await runReceiptStep("showed:stage_sync", () => onStageChange(local.merchantId, "STATEMENT_REQUESTED", local.oldStage ?? undefined));
  }
  if (isSdrGhlConfigured()) {
    await enrollStep("showed:enroll_statement_request", { id: local.merchantId, ghlContactId }, "statement_request_after_meeting",
      { meetingId: local.meetingId, shownAt: webhookData.startTime });
  }
  console.log(`[Scheduling] Appointment showed for merchant ${local.merchantId}: ${local.meetingId}`);
}

export async function handleAppointmentCanceled(webhookData: AppointmentWebhookData): Promise<void> {
  const ghlContactId = webhookData.contactId;
  if (!ghlContactId) return;
  const canceledId = webhookData.appointmentId || webhookData.id;

  const { result: local } = await runReceiptTxStep("canceled:local", async tx => {
    if (await ghlAppointmentSuperseded(tx, webhookData, "canceled")) return { outcome: "superseded" as const };
    const [merchant] = await tx.select().from(sdrMerchants).where(eq(sdrMerchants.ghlContactId, ghlContactId));
    if (!merchant) {
      await recordOrphanAppointmentEvent(tx, "appointment_canceled", webhookData, ghlContactId);
      return { outcome: "orphan" as const };
    }
    const [state] = await tx.select().from(sdrLeadState).where(eq(sdrLeadState.merchantId, merchant.id));
    const wasMeetingSet = state?.currentStage === "MEETING_SET";
    if (wasMeetingSet) {
      await tx.update(sdrLeadState).set({
        currentStage: "ENGAGED", meetingId: null, nextAction: "no_show_recovery", nextActionType: "recovery_sequence",
        nextActionAt: new Date(Date.now() + 30 * 60_000), nextActionPayload: { canceledAppointmentId: canceledId },
        updatedAt: new Date(),
      }).where(eq(sdrLeadState.merchantId, merchant.id));
    }
    await tx.insert(sdrLeadEvents).values({
      merchantId: merchant.id, eventType: "appointment_canceled", channel: "calendar", actorType: "merchant",
      payloadJson: webhookData, ghlRefId: webhookData.appointmentId || webhookData.id || null,
      decisionReason: "Appointment canceled — triggered no-show recovery sequence",
    });
    return { outcome: "applied" as const, merchantId: merchant.id, wasMeetingSet };
  });
  if (local.outcome !== "applied") return;

  if (local.wasMeetingSet) {
    await runReceiptStep("canceled:stage_sync", () => onStageChange(local.merchantId, "ENGAGED", "MEETING_SET"));
    const { upsertOutreachPause } = await import("./compliance-engine");
    await runReceiptStep("canceled:outreach_resume", () => upsertOutreachPause(local.merchantId, false, "Outreach resumed — appointment canceled, recovery sequence triggered"));
  }
  await enrollStep("canceled:enroll_no_show_reschedule", { id: local.merchantId, ghlContactId }, "no_show_reschedule",
    { canceledAppointmentId: canceledId });

  console.log(`[Scheduling] Appointment canceled for merchant ${local.merchantId}`);
}

export async function sendReminders(merchantId: number): Promise<boolean> {
  const [state] = await db.select().from(sdrLeadState).where(eq(sdrLeadState.merchantId, merchantId));
  if (!state || state.currentStage !== "MEETING_SET" || !state.meetingId) {
    return false;
  }

  const [merchant] = await db.select().from(sdrMerchants).where(eq(sdrMerchants.id, merchantId));
  if (!merchant?.ghlContactId || !isSdrGhlConfigured()) {
    return false;
  }

  const { checkAndLogCompliance } = await import("./compliance-engine");
  const complianceResult = await checkAndLogCompliance(merchantId, "sms", "reminder");
  if (!complianceResult.allowed) {
    console.warn(`[Scheduling] Reminder blocked for merchant ${merchantId}: ${complianceResult.reason}`);
    return false;
  }

  try {
    const reminderResult = await enrollMerchantWorkflow(merchant, "booking_reminder_24h", { meetingId: state.meetingId });
    if (!reminderResult.success) {
      console.warn(`[Scheduling] Appointment reminder suppressed for merchant ${merchantId}: ${reminderResult.error}`);
      return false;
    }

    await db.insert(sdrLeadEvents).values({
      merchantId,
      eventType: "reminder_sent",
      channel: "sms",
      actorType: "system",
      payloadJson: { meetingId: state.meetingId },
      decisionReason: "Appointment reminder sent",
    });

    console.log(`[Scheduling] Reminder sent for merchant ${merchantId}, meeting ${state.meetingId}`);
    return true;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Scheduling] Failed to send reminder for merchant ${merchantId}:`, errMsg);
    return false;
  }
}
