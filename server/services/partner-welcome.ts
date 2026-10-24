import { sendEmailReply, triggerWorkflow, upsertContact, isSdrGhlConfigured } from "./sdr/ghl-client";
import { getEmailSignatureHtml } from "./email-signatures";
import { storage } from "../storage";
import type { Partner } from "@shared/schema";

function getBaseUrl(): string {
  const replitDomain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  return process.env.APP_URL || (replitDomain ? `https://${replitDomain}` : "https://libertybancard.com");
}

function buildPartnerWelcomeEmail(partner: Partner, referralLink: string, portalUrl: string): string {
  const firstName = (partner.contactName || "").split(" ")[0] || "Partner";
  const companyName = partner.companyName || "your company";
  const affiliateCode = partner.affiliateCode || "";
  const commissionPercent = partner.commissionPercent ?? 10;

  const signature = getEmailSignatureHtml("partners", undefined, null);

  return `
<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;max-width:600px;">
  <p>Hi ${firstName},</p>

  <p>Great news — your Liberty Bancard partner application has been <strong>approved</strong>! Welcome to the program, ${companyName}.</p>

  <p>Here's everything you need to get started:</p>

  <p><strong>Your Referral Link</strong><br/>
  Share this link with merchants and we'll automatically track every referral:<br/>
  <a href="${referralLink}" style="color:#1e3a5f;">${referralLink}</a></p>

  <p><strong>Your Referral Code</strong>: <code style="background:#f4f4f4;padding:2px 6px;border-radius:3px;font-size:13px;">${affiliateCode}</code></p>

  <p><strong>Your Commission Rate</strong>: <strong>${commissionPercent}%</strong> on every merchant you refer who activates processing.</p>

  <p><strong>Partner Portal</strong><br/>
  Log in to track your referrals, commissions, and payouts:<br/>
  <a href="${portalUrl}" style="display:inline-block;background-color:#1e3a5f;color:#ffffff;padding:10px 20px;border-radius:4px;text-decoration:none;font-size:13px;font-weight:bold;margin-top:6px;">Access Your Partner Portal &rarr;</a></p>

  <p><strong>How it works:</strong></p>
  <ol>
    <li>Share your referral link or code with business owners</li>
    <li>They apply and start processing — we handle everything</li>
    <li>You earn ${commissionPercent}% residual commission each month they process</li>
    <li>Commissions are paid monthly via PayPal</li>
  </ol>

  <p><strong>Marketing Resources</strong></p>
  <ul>
    <li><a href="https://libertybancard.com/partners/collateral" style="color:#1e3a5f;">Download partner collateral &amp; flyers</a></li>
    <li><a href="https://libertybancard.com/free-analysis" style="color:#1e3a5f;">Send merchants a free savings analysis</a></li>
    <li><a href="https://libertybancard.com/apply" style="color:#1e3a5f;">Direct merchant application link</a></li>
  </ul>

  <p>Questions? Reply to this email or call 954-266-8214. We're here to help you succeed.</p>

  <p>Welcome aboard!</p>

  ${signature}
</div>
`;
}

export type PartnerWelcomeResult = "sent" | "not_configured" | "no_provider_contact";

/**
 * One delivery attempt of the approval welcome. Throws when the provider call fails (the caller owns retry/ambiguity);
 * returns "not_configured" / "no_provider_contact" when a prerequisite is missing so the caller can wait instead of
 * recording a send that never happened. Writes the "sent" audit row only after a provider handoff.
 */
export async function deliverPartnerWelcome(partner: Partner): Promise<PartnerWelcomeResult> {
  if (!partner.email) throw new Error("PARTNER_WELCOME_NO_EMAIL");
  if (!isSdrGhlConfigured()) return "not_configured";

  const baseUrl = getBaseUrl();
  const referralLink = `${baseUrl}?ref=${partner.affiliateCode || ""}`;
  const portalUrl = `${baseUrl}/partner-portal`;
  const ghlWorkflowId = process.env.GHL_WORKFLOW_PARTNER_WELCOME;
  const nameParts = (partner.contactName || "").split(" ");
  const ghlContactId = await upsertContact({
    firstName: nameParts[0] || "",
    lastName: nameParts.slice(1).join(" ") || "",
    email: partner.email,
    phone: partner.phone || undefined,
    companyName: partner.companyName || undefined,
    tags: ["partner", "approved", partner.partnerType || "referral"],
  });
  if (!ghlContactId) return "no_provider_contact";

  let method: "ghl_workflow" | "direct_email";
  if (ghlWorkflowId) {
    await triggerWorkflow({
      workflowId: ghlWorkflowId,
      contactId: ghlContactId,
      metadata: {
        partnerId: partner.id, affiliateCode: partner.affiliateCode, referralLink, portalUrl,
        commissionPercent: partner.commissionPercent, source: "partner_approved", approvedAt: new Date().toISOString(),
      },
    });
    method = "ghl_workflow";
  } else {
    const subject = `Welcome to Liberty Bancard's Partner Program — you're approved!`;
    const htmlBody = buildPartnerWelcomeEmail(partner, referralLink, portalUrl);
    await sendEmailReply({ contactId: ghlContactId, commercialPurpose: "transactional_response", subject, htmlBody, fromEmail: "partners@libertybancard.com", fromName: "Liberty Bancard Partner Program" });
    method = "direct_email";
  }
  await storage.createAuditLog({
    action: "partner_welcome_sent", entityType: "partner", entityId: partner.id,
    details: { email: partner.email, method, affiliateCode: partner.affiliateCode },
  }).catch(() => undefined);
  return "sent";
}
