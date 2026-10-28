/**
 * SDR event kinds. A reply, an opt-out (STOP), a bounce and a delivery outcome are different facts and are never
 * folded into one another or into "engaged". Classification looks at the stored event type and, for the generic
 * inbound `message_received` event, the delivery status and direction in its payload.
 */
export type SdrEventKind = "reply" | "opt_out" | "bounce" | "delivery_failure" | "delivery" | "other";

const OPT_OUT_BODY = /^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*[.!]?\s*$/i;

export function classifySdrEventKind(eventType: string, payload?: Record<string, any> | null): SdrEventKind {
  const type = String(eventType || "").toLowerCase();
  if (type === "opt_out" || type === "unsubscribe") return "opt_out";
  if (type === "email_bounce" || type === "bounce") return "bounce";
  if (type === "sms_undeliverable" || type === "delivery_failed") return "delivery_failure";
  if (type === "delivered" || type === "delivery_confirmed") return "delivery";
  if (type === "email_reply" || type === "sms_reply") return "reply";
  if (type === "message_received") {
    const status = String(payload?.status ?? payload?.deliveryStatus ?? "");
    if (/failed|undelivered|undeliverable/i.test(status)) return "delivery_failure";
    if (/^delivered$/i.test(status)) return "delivery";
    if (payload?.direction !== "inbound") return "other";
    const body = String(payload?.body ?? payload?.message ?? "");
    if (OPT_OUT_BODY.test(body)) return "opt_out";
    return "reply";
  }
  return "other";
}

export function countSdrEventKinds(
  events: Array<{ eventType: string; payloadJson?: Record<string, any> | null; n?: number }>,
): Record<SdrEventKind, number> {
  const out: Record<SdrEventKind, number> = { reply: 0, opt_out: 0, bounce: 0, delivery_failure: 0, delivery: 0, other: 0 };
  for (const e of events) out[classifySdrEventKind(e.eventType, e.payloadJson)] += e.n ?? 1;
  return out;
}
