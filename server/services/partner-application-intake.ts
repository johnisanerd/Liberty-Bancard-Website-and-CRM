/**
 * Local completion of a claimed partner-application (or affiliate-signup) occurrence.
 *
 * Every step is idempotent and uses the existing authorities: the contact writer with the partner source contract
 * (`website_form|partner_application`, event key derived from the occurrence), a command-keyed review notification, and
 * the inbound request orchestrator. Because the steps are repeatable, a replay of a partially completed occurrence
 * resumes the missing work once instead of telling the applicant to resubmit. No provider call is made here: the
 * contact writer records durable provider work, and the receipt owner decides whether any email is ever sent.
 */
import { storage } from "../storage";
import { createContactLocalFirst } from "./contact-writer";
import { linkInboundRequest, orchestrateInboundRequest, setInboundRequestLifecycle } from "./inbound-request-authority";
import type { InboundRequest } from "@shared/schema";
import { describeAckReceiptState } from "./inbound-acknowledgement";
import { resolveReviewAssignment, reviewMetadata } from "./inbound-review-policy";
import { logOperationalDiagnostic } from "../utils/server-error";

export interface PartnerApplicationSubject {
  id: number;
  email: string;
  phone?: string | null;
  contactName?: string | null;
  companyName?: string | null;
  partnerType?: string | null;
  affiliateCode?: string | null;
}

export interface LocalCompletion {
  localContactId: number | null;
  contactRecorded: boolean;
  reviewNotified: boolean;
  emailReceipt: "queued" | "not_enabled";
}

function splitName(full: string | null | undefined): { firstName: string; lastName: string } {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
}

export async function completePartnerApplicationLocal(
  inbound: Pick<InboundRequest, "id" | "sourceReceivedAt">,
  partner: PartnerApplicationSubject,
  variant: "partner" | "affiliate",
): Promise<LocalCompletion> {
  const email = partner.email.trim().toLowerCase();
  // Capture the mailbox first so a later resume can find this application from the occurrence alone.
  await linkInboundRequest(inbound.id, { submittedEmail: email });

  let localContactId: number | null = null;
  let contactRecorded = false;
  try {
    const existing = await storage.getContactByEmail(email);
    if (existing) {
      // The same mailbox is the same contact: link it, never modify it.
      localContactId = existing.id;
    } else {
      const { firstName, lastName } = splitName(partner.contactName);
      const created = await createContactLocalFirst({
        firstName,
        lastName,
        email,
        phone: partner.phone ?? "",
        companyName: partner.companyName || undefined,
        status: "Active",
        tags: variant === "affiliate" ? ["src_website", "affiliate"] : ["src_website", "iso_partner_application", partner.partnerType ?? "referral"],
      }, undefined, {
        sourceCategory: "website_form",
        sourceType: "partner_application",
        eventKey: `form:partner_application:${inbound.id}`,
      });
      localContactId = created?.id ?? null;
    }
    contactRecorded = localContactId != null;
  } catch (err) {
    logOperationalDiagnostic("partner_application_sync", err, "contact_create_failed", { partnerId: partner.id });
  }

  const assignment = await resolveReviewAssignment("partner_application_request", inbound.sourceReceivedAt ?? new Date());
  const label = (partner.companyName || partner.contactName || "A new applicant").toString().trim().slice(0, 120);
  let reviewNotified = false;
  let emailReceipt: "queued" | "not_enabled" = "not_enabled";
  try {
    const notification = await storage.createNotification({
      channel: "internal",
      title: variant === "affiliate" ? "New affiliate signup to review" : "New partner application to review",
      message: variant === "affiliate"
        ? `${label} signed up as an affiliate.`
        : `${label} applied as ${(partner.partnerType ?? "referral").replace(/_/g, " ")}.`,
      type: "alert",
      inboundRequestId: inbound.id,
      commandKey: `inbound:${inbound.id}:review-notification`,
      metadata: {
        partnerId: partner.id,
        link: "/dashboard/referral-program",
        eventType: "partner_application_received",
        audienceRoles: ["admin"],
        ...reviewMetadata(assignment),
      },
    } as any);
    const orchestrated = await orchestrateInboundRequest({ requestId: inbound.id, contactId: localContactId, notificationId: notification.id });
    reviewNotified = orchestrated.lifecycleState !== "review_required";
    emailReceipt = await describeAckReceiptState(inbound.id);
  } catch (err) {
    logOperationalDiagnostic("partner_application_review", err, "review_notification_failed", { partnerId: partner.id });
    await setInboundRequestLifecycle(inbound.id, "review_required", "REVIEW_NOTIFICATION_FAILED").catch(() => undefined);
  }
  if (!contactRecorded) {
    // Truthful and resumable: the contact record is missing, so the occurrence stays visible for review/resume.
    await setInboundRequestLifecycle(inbound.id, "review_required", "CONTACT_RECORD_FAILED").catch(() => undefined);
  }
  return { localContactId, contactRecorded, reviewNotified: reviewNotified && contactRecorded, emailReceipt };
}

/**
 * Replay of an occurrence that did not finish: finish the missing local work from what was durably recorded.
 * Returns `{ failed }` when nothing durable exists to resume from (the account was never created), so the caller
 * can say so truthfully instead of reporting success.
 */
export async function resumePartnerApplication(
  request: Pick<InboundRequest, "id" | "lifecycleState" | "submittedEmail" | "sourceReceivedAt">,
  variant: "partner" | "affiliate",
): Promise<{ failed?: string; state?: string }> {
  if (!["claimed", "processing", "review_required"].includes(String(request.lifecycleState))) return {};
  const email = request.submittedEmail?.trim().toLowerCase();
  const partner = email ? await storage.getPartnerByEmail(email) : undefined;
  if (!partner) {
    await setInboundRequestLifecycle(request.id, "failed", "PARTIAL_INTAKE_NO_ACCOUNT");
    return { failed: "PARTIAL_INTAKE_NO_ACCOUNT" };
  }
  const done = await completePartnerApplicationLocal(request, partner as PartnerApplicationSubject, variant);
  return { state: done.contactRecorded && done.reviewNotified ? "accepted" : "review_required" };
}
