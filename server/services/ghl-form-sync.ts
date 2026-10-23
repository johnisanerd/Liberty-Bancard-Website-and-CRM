import crypto from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { merchantApplications, contactProviderProjections } from "@shared/schema";
import { isGhlConfigured } from "./ghl";
import { syncDealToGhl } from "./ghl-sync";
import { triggerWorkflow, updateCustomFields, addTag, addNote, isSdrGhlConfigured } from "./sdr/ghl-client";
import { storage } from "../storage";
import { getSafeApplicationMasks } from "./merchant-protected-data";

export type LeadSourceType =
  | "free_analysis"
  | "get_started"
  | "statement_upload"
  | "merchant_application"
  | "support"
  | "affiliate"
  | "cost_quiz"
  | "estimate"
  | "callback"
  | "equipment_order";

export interface FormSyncParams {
  contactId: number;
  dealId?: number;
  leadSource: LeadSourceType;
  formData?: Record<string, string | boolean | number | undefined>;
  skipWorkflowTrigger?: boolean;
  sequenceName?: string;
}

function isGhlReady(): boolean {
  return isGhlConfigured() || isSdrGhlConfigured();
}

/** Idempotent durable handoff: one consumable pending projection per contact, claimed by the projection worker. */
export async function enqueueGhlContactProjection(contactId: number): Promise<void> {
  await db.insert(contactProviderProjections).values({
    contactId,
    provider: "ghl",
    projectionKey: `contact:${contactId}`,
    state: "pending",
  }).onConflictDoUpdate({
    target: [
      contactProviderProjections.contactId,
      contactProviderProjections.provider,
      contactProviderProjections.projectionKey,
    ],
    set: { state: "pending", lastErrorCode: null, nextAttemptAt: new Date(), updatedAt: new Date() },
  });
}

async function legacyContactSyncDisabled(): Promise<{ success: false; error: string; ghlContactId?: undefined }> {
  return {
    success: false,
    error: "Direct GHL contact synchronization is disabled; use a durable contact projection.",
  };
}

export type GatedMutationResult<T> =
  | { ok: true; result: T }
  | { ok: false; skipped: true; reason: string };

/**
 * C-10 (#1626): canonical pause-authority protocol for the raw GHL mutation
 * fetch() call sites in this file (opportunity POST, task POST, affiliate
 * contact POST, DND PUT). Runs the FULL linearization barrier:
 *   authorize → registerInflight(token, epoch) → recheckEpoch(epoch)
 *   → provider I/O → deregisterInflight
 * so a pause that transitions to "activating" after authorization cannot
 * still permit the mutation. Fail-closed: any error reading the pause state
 * denies the mutation.
 *
 * `testHooks.afterRegister` is a test-only seam used by the interleaving test
 * to mutate the pause epoch between registration and the epoch recheck.
 */
export async function gatedGhlMutation<T>(
  tag: string,
  fn: () => Promise<T>,
  testHooks?: { afterRegister?: () => Promise<void> },
): Promise<GatedMutationResult<T>> {
  try {
    const { authorize, recheckEpoch } = await import("./outbound-pause-authority");
    const { registerInflight, deregisterInflight } = await import("./outbound-control-service");
    const decision = await authorize({});
    if (!decision.allowed) {
      return { ok: false, skipped: true, reason: decision.reasonCode ?? "denied" };
    }
    const token = crypto.randomUUID();
    await registerInflight(token, decision.epoch);
    try {
      if (testHooks?.afterRegister) await testHooks.afterRegister();
      const epochOk = await recheckEpoch(decision.epoch);
      if (!epochOk) {
        console.warn(`[GHL Form Sync] ${tag} aborted — pause epoch changed before provider I/O`);
        return { ok: false, skipped: true, reason: "epoch_changed" };
      }
      return { ok: true, result: await fn() };
    } finally {
      deregisterInflight(token);
    }
  } catch (err: any) {
    console.error(`[GHL Form Sync] Pause authority protocol failed for ${tag} — fail closed:`, err?.message ?? err);
    return { ok: false, skipped: true, reason: "pause_authority_error" };
  }
}

export async function syncFormSubmissionToGhl(params: FormSyncParams): Promise<{
  success: boolean;
  ghlContactId?: string;
  error?: string;
}> {
  const legacyDirectOwner =
    (globalThis as { __BT10_LEGACY_GHL_FORM_DIRECT_OWNER__?: boolean })
      .__BT10_LEGACY_GHL_FORM_DIRECT_OWNER__ === true;
  if (!legacyDirectOwner) {
    const { db } = await import("../db");
    const { contactProviderProjections } = await import("@shared/schema");
    await db.insert(contactProviderProjections).values({
      contactId: params.contactId,
      provider: "ghl",
      projectionKey: `contact:${params.contactId}`,
      state: "pending",
    }).onConflictDoUpdate({
      target: [
        contactProviderProjections.contactId,
        contactProviderProjections.provider,
        contactProviderProjections.projectionKey,
      ],
      set: { state: "pending", lastErrorCode: null, nextAttemptAt: new Date(), updatedAt: new Date() },
    });
    return { success: true };
  }
  try {
    if (!isGhlReady()) {
      console.warn(`[GHL Form Sync] GHL not configured — skipping sync for ${params.leadSource}`);
      return { success: false, error: "GHL not configured" };
    }

    const contact = await storage.getContact(params.contactId);
    if (!contact) return { success: false, error: "Contact not found" };

    const syncResult = await legacyContactSyncDisabled();
    if (!syncResult.success) {
      console.warn(`[GHL Form Sync] Contact sync failed for ${params.contactId}: ${syncResult.error}`);
      return { success: false, error: syncResult.error };
    }

    const ghlContactId = syncResult.ghlContactId || contact.ghlContactId;
    if (!ghlContactId) {
      return { success: false, error: "No GHL contact ID returned" };
    }

    const customFields: Record<string, string> = {};

    customFields["lb_lead_source"] = params.leadSource;

    if (contact.vertical) customFields["lb_vertical"] = contact.vertical;
    if (contact.monthlyVolume) customFields["lb_monthly_volume"] = contact.monthlyVolume;
    if (contact.currentProvider) customFields["lb_current_processor"] = contact.currentProvider;
    if (contact.primaryOfferPath) customFields["lb_preferred_program"] = contact.primaryOfferPath;
    if (contact.utmSource) customFields["lb_utm_source"] = contact.utmSource;
    if (contact.utmMedium) customFields["lb_utm_medium"] = contact.utmMedium;
    if (contact.utmCampaign) customFields["lb_utm_campaign"] = contact.utmCampaign;
    if (contact.utmContent) customFields["lb_utm_content"] = contact.utmContent;
    if (contact.utmTerm) customFields["lb_utm_term"] = contact.utmTerm;
    if (contact.gclid) customFields["lb_gclid"] = contact.gclid;
    if ((contact as any).referrerUrl) customFields["lb_referrer_url"] = (contact as any).referrerUrl;
    if (contact.promoCode) customFields["lb_promo_code"] = contact.promoCode;
    if (contact.landingPage) customFields["lb_landing_page"] = contact.landingPage;
    if (contact.estimatedResidual) customFields["lb_estimated_savings"] = contact.estimatedResidual;

    customFields["lb_consent_sms"] = contact.consentSms ? "yes" : "no";
    customFields["lb_consent_email"] = contact.consentEmail ? "yes" : "no";

    if (contact.interestedIn0Percent) customFields["lb_interested_0_percent"] = "yes";
    if (contact.needTerminal) customFields["lb_terminal_need"] = "yes";

    if (contact.painPoints && Array.isArray(contact.painPoints) && contact.painPoints.length > 0) {
      customFields["lb_pain_points"] = contact.painPoints.join(", ");
    }

    if (params.formData) {
      for (const [key, value] of Object.entries(params.formData)) {
        if (value !== undefined && value !== null && value !== "") {
          customFields[key] = String(value);
        }
      }
    }

    if (Object.keys(customFields).length > 0) {
      try {
        await updateCustomFields(ghlContactId, customFields);
      } catch (cfErr) {
        console.error(`[GHL Form Sync] Custom field update failed for contact ${params.contactId}:`, cfErr);
      }
    }

    const sourceTag = getSourceTag(params.leadSource);
    if (sourceTag) {
      try {
        await addTag({ contactId: ghlContactId, tags: [sourceTag] });
      } catch (tagErr) {
        console.error(`[GHL Form Sync] Tag add failed:`, tagErr);
      }
    }

    if (!contact.consentSms) {
      try {
        await setGhlDnd(ghlContactId, "sms", true);
      } catch (dndErr) {
        console.error(`[GHL Form Sync] DND SMS set failed:`, dndErr);
      }
    } else {
      try {
        await setGhlDnd(ghlContactId, "sms", false);
      } catch (dndErr) {
        console.error(`[GHL Form Sync] DND SMS clear failed:`, dndErr);
      }
    }

    if (!contact.consentEmail) {
      try {
        await setGhlDnd(ghlContactId, "email", true);
      } catch (dndErr) {
        console.error(`[GHL Form Sync] DND Email set failed:`, dndErr);
      }
    } else {
      try {
        await setGhlDnd(ghlContactId, "email", false);
      } catch (dndErr) {
        console.error(`[GHL Form Sync] DND Email clear failed:`, dndErr);
      }
    }

    if (params.dealId) {
      syncDealToGhl(params.dealId).catch(err => {
        console.error(`[GHL Form Sync] Deal sync failed for deal ${params.dealId}:`, err);
      });
    }

    if (!params.skipWorkflowTrigger) {
      let workflowId: string | null = null;

      if (params.sequenceName) {
        const envKey = `GHL_WORKFLOW_${params.sequenceName
          .replace(/[^a-zA-Z0-9]+/g, "_")
          .replace(/^_|_$/g, "")
          .toUpperCase()}`;
        workflowId = process.env[envKey] || null;

        if (!workflowId) {
          const dbMapping = await storage.getSystemSetting(`ghl_workflow_id:${params.sequenceName}`);
          if (dbMapping) workflowId = dbMapping;
        }
      }

      if (!workflowId) {
        workflowId = getInboundWorkflowId(params.leadSource);
      }

      if (workflowId) {
        try {
          await triggerWorkflow({
            workflowId,
            contactId: ghlContactId,
            metadata: {
              leadSource: params.leadSource,
              sequenceName: params.sequenceName,
              contactId: params.contactId,
              dealId: params.dealId,
            },
          });
        } catch (wfErr) {
          console.error(`[GHL Form Sync] Workflow trigger failed:`, wfErr);
        }
      }
    }

    console.log(`[GHL Form Sync] Synced ${params.leadSource} form for contact ${params.contactId} → GHL ${ghlContactId}`);
    return { success: true, ghlContactId };
  } catch (err: any) {
    console.error(`[GHL Form Sync] Error syncing form submission:`, err.message);
    return { success: false, error: err.message };
  }
}

export async function syncMerchantApplicationToGhl(applicationId: number, contactId: number): Promise<{ success: boolean; error?: string }> {
  if (!(globalThis as { __BT10_LEGACY_GHL_FORM_DIRECT_OWNER__?: boolean }).__BT10_LEGACY_GHL_FORM_DIRECT_OWNER__) {
    await enqueueGhlContactProjection(contactId);
    return { success: true };
  }
  try {
    if (!isGhlReady()) return { success: false, error: "GHL not configured" };

    // Explicit least-privilege projection: only non-sensitive columns plus the
    // persisted display-safe mask columns needed by getSafeApplicationMasks.
    // NEVER select protected ciphertext (ein/ownerSsn/ownerDob/bank*), raw
    // fingerprints, tokens, or capability columns.
    const [application] = await db
      .select({
        businessType: merchantApplications.businessType,
        vertical: merchantApplications.vertical,
        estimatedMonthlyVolume: merchantApplications.estimatedMonthlyVolume,
        estimatedAvgTicket: merchantApplications.estimatedAvgTicket,
        currentProcessor: merchantApplications.currentProcessor,
        currentRate: merchantApplications.currentRate,
        preferredProgram: merchantApplications.preferredProgram,
        terminalNeeded: merchantApplications.terminalNeeded,
        terminalType: merchantApplications.terminalType,
        terminalQuantity: merchantApplications.terminalQuantity,
        ecommerceNeeded: merchantApplications.ecommerceNeeded,
        legalBusinessName: merchantApplications.legalBusinessName,
        dba: merchantApplications.dba,
        bankName: merchantApplications.bankName,
        // Persisted display-safe masks only (never ciphertext/fingerprints).
        einMask: merchantApplications.einMask,
        ssnMask: merchantApplications.ssnMask,
        bankAccountMask: merchantApplications.bankAccountMask,
        bankRoutingMask: merchantApplications.bankRoutingMask,
      })
      .from(merchantApplications)
      .where(eq(merchantApplications.id, applicationId))
      .limit(1);
    if (!application) return { success: false, error: "Application not found" };

    const contact = await storage.getContact(contactId);
    if (!contact) return { success: false, error: "Contact not found" };

    const syncResult = await legacyContactSyncDisabled();
    const ghlContactId = syncResult.ghlContactId || contact.ghlContactId;
    if (!ghlContactId) return { success: false, error: "No GHL contact" };

    const appFields: Record<string, string> = {
      lb_lead_source: "merchant_application",
      lb_business_type: application.businessType || "",
      lb_vertical: application.vertical || "",
    };

    if (application.estimatedMonthlyVolume) appFields["lb_monthly_volume"] = String(application.estimatedMonthlyVolume);
    if (application.estimatedAvgTicket) appFields["lb_avg_ticket"] = String(application.estimatedAvgTicket);
    if (application.currentProcessor) appFields["lb_current_processor"] = application.currentProcessor;
    if (application.currentRate) appFields["lb_current_rate"] = application.currentRate;
    if (application.preferredProgram) appFields["lb_preferred_program"] = application.preferredProgram;
    if (application.terminalNeeded) appFields["lb_terminal_need"] = "yes";
    if (application.terminalType) appFields["lb_terminal_type"] = application.terminalType;
    if (application.ecommerceNeeded !== undefined && application.ecommerceNeeded !== null) {
      appFields["lb_ecommerce_needed"] = application.ecommerceNeeded ? "yes" : "no";
    }

    // Protected fields (EIN, bank account) never leave this service raw — only
    // safe masks / last-4 metadata are synced to GHL. getSafeApplicationMasks
    // reads ONLY the persisted mask columns projected above.
    const masks = getSafeApplicationMasks({ id: applicationId, ...application });
    if (masks.einLast4) appFields["lb_ein_last4"] = masks.einLast4;

    await updateCustomFields(ghlContactId, appFields);

    await addTag({ contactId: ghlContactId, tags: ["LB-MERCHANT-APP"] });

    const maskedBank = masks.bankAccountMasked ?? "N/A";
    const noteBody = [
      `Merchant Application #${applicationId}`,
      `Legal Name: ${application.legalBusinessName || "N/A"}`,
      `DBA: ${application.dba || "N/A"}`,
      `Business Type: ${application.businessType || "N/A"}`,
      `Industry: ${application.vertical || "N/A"}`,
      `Est. Monthly Volume: ${application.estimatedMonthlyVolume || "N/A"}`,
      `Avg Ticket: ${application.estimatedAvgTicket || "N/A"}`,
      `Current Processor: ${application.currentProcessor || "N/A"}`,
      `Preferred Program: ${application.preferredProgram || "N/A"}`,
      `Terminal: ${application.terminalNeeded ? `${application.terminalType || "Yes"} x${application.terminalQuantity || 1}` : "No"}`,
      `Bank: ${application.bankName || "N/A"} (${maskedBank})`,
    ].join("\n");

    await addNote({ contactId: ghlContactId, body: noteBody });

    const pipelineId = process.env.GHL_ONBOARDING_PIPELINE_ID;
    if (pipelineId) {
      const stageId = process.env.GHL_ONBOARDING_STAGE_NEW || "new";
      try {
        const apiKey = process.env.GHL_PRIVATE_INTEGRATION_TOKEN || process.env.GHL_API_KEY;
        const locationId = process.env.GHL_LOCATION_ID;
        if (apiKey && locationId) {
          // C-10 (#1626): full pause-authority protocol around the raw GHL mutation
          const gated = await gatedGhlMutation("opportunity_create", () =>
            fetch("https://services.leadconnectorhq.com/opportunities/", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "Version": "2021-07-28",
              },
              body: JSON.stringify({
                pipelineId,
                pipelineStageId: stageId,
                locationId,
                contactId: ghlContactId,
                name: `${application.legalBusinessName || application.dba || "Merchant"} - Application #${applicationId}`,
                status: "open",
                monetaryValue: application.estimatedMonthlyVolume ? parseFloat(String(application.estimatedMonthlyVolume).replace(/[^0-9.]/g, "")) || 0 : 0,
              }),
            }),
          );
          if (!gated.ok) {
            console.warn(`[GHL Form Sync] Opportunity create skipped — pause authority denied (${gated.reason})`);
          } else if (!gated.result.ok) {
            // C-10 (#1626): check HTTP status — status code only, no ids/bodies.
            console.error(`[GHL Form Sync] Onboarding opportunity POST failed: HTTP ${gated.result.status}`);
          }
        }
      } catch {
        // Safe generic log — never echo provider message/body.
        console.error(`[GHL Form Sync] Failed to create onboarding opportunity`);
      }
    }

    console.log(`[GHL Form Sync] Merchant application ${applicationId} synced to GHL`);
    return { success: true };
  } catch {
    // Return/log safe generic errors only — no provider message/body/ids.
    console.error(`[GHL Form Sync] Merchant app sync error`);
    return { success: false, error: "merchant_app_sync_failed" };
  }
}

export async function syncStatementUploadToGhl(contactId: number, fileName: string): Promise<{ success: boolean; error?: string }> {
  if (!(globalThis as { __BT10_LEGACY_GHL_FORM_DIRECT_OWNER__?: boolean }).__BT10_LEGACY_GHL_FORM_DIRECT_OWNER__) {
    await enqueueGhlContactProjection(contactId);
    return { success: true };
  }
  try {
    if (!isGhlReady()) return { success: false, error: "GHL not configured" };

    const contact = await storage.getContact(contactId);
    let ghlContactId = contact?.ghlContactId || null;

    if (!ghlContactId) {
      const syncResult = await legacyContactSyncDisabled();
      ghlContactId = syncResult.ghlContactId || null;
    }

    if (!ghlContactId) return { success: false, error: "No GHL contact" };

    await updateCustomFields(ghlContactId, {
      lb_statement_status: "received",
    });

    await addTag({ contactId: ghlContactId, tags: ["LB-STATEMENT-RECEIVED"] });

    await addNote({
      contactId: ghlContactId,
      body: `Processing statement uploaded: ${fileName}. Review pending.`,
    });

    // NOTE: workflow enrollment (GHL_WORKFLOW_STATEMENT_REVIEW / inbound confirmation)
    // is owned exclusively by enrollInInboundConfirmation in the upload chain Step 9.
    // Do NOT trigger any workflow here — this function is sync-only.

    return { success: true };
  } catch (err: any) {
    console.error(`[GHL Form Sync] Statement upload sync error:`, err.message);
    return { success: false, error: err.message };
  }
}

export async function syncSupportTicketToGhl(contactId: number, ticketId: number, issueType: string, description: string): Promise<{ success: boolean; error?: string }> {
  if (!(globalThis as { __BT10_LEGACY_GHL_FORM_DIRECT_OWNER__?: boolean }).__BT10_LEGACY_GHL_FORM_DIRECT_OWNER__) {
    await enqueueGhlContactProjection(contactId);
    return { success: true };
  }
  try {
    if (!isGhlReady()) return { success: false, error: "GHL not configured" };

    const contact = await storage.getContact(contactId);
    let ghlContactId = contact?.ghlContactId || null;

    if (!ghlContactId) {
      const syncResult = await legacyContactSyncDisabled();
      ghlContactId = syncResult.ghlContactId || null;
    }

    if (!ghlContactId) return { success: false, error: "No GHL contact" };

    await addTag({ contactId: ghlContactId, tags: ["LB-SUPPORT"] });

    await addNote({
      contactId: ghlContactId,
      body: `Support ticket #${ticketId} created.\nIssue: ${issueType}\n${description}`,
    });

    const supportAssignee = process.env.GHL_SUPPORT_TEAM_USER_ID;
    const apiKey = process.env.GHL_PRIVATE_INTEGRATION_TOKEN || process.env.GHL_API_KEY;
    if (apiKey && ghlContactId) {
      try {
        const taskPayload: Record<string, unknown> = {
          title: `Support: ${issueType} - Ticket #${ticketId}`,
          body: `Issue Type: ${issueType}\n${description.slice(0, 500)}`,
          dueDate: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
          completed: false,
        };
        if (supportAssignee) taskPayload.assignedTo = supportAssignee;

        // C-10 (#1626): full pause-authority protocol around the raw GHL mutation
        const gated = await gatedGhlMutation("support_task_create", () =>
          fetch(`https://services.leadconnectorhq.com/contacts/${ghlContactId}/tasks`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "Version": "2021-07-28",
            },
            body: JSON.stringify(taskPayload),
          }),
        );
        if (!gated.ok) {
          console.warn(`[GHL Form Sync] Support task creation skipped — pause authority denied (${gated.reason})`);
        } else if (!gated.result.ok) {
          // C-10 (#1626): check HTTP status — do not swallow failures
          console.error(`[GHL Form Sync] Support task POST failed: HTTP ${gated.result.status} (ticket #${ticketId}, ghlContactId=${ghlContactId})`);
        }
      } catch (taskErr: any) {
        console.error(`[GHL Form Sync] Support task creation failed:`, taskErr?.message ?? taskErr);
      }
    }

    const workflowId = process.env.GHL_WORKFLOW_SUPPORT_TICKET;
    if (workflowId) {
      await triggerWorkflow({
        workflowId,
        contactId: ghlContactId,
        metadata: { ticketId, issueType },
      });
    }

    return { success: true };
  } catch (err: any) {
    console.error(`[GHL Form Sync] Support ticket sync error:`, err.message);
    return { success: false, error: err.message };
  }
}

export async function syncAffiliateSignupToGhl(params: {
  firstName: string;
  lastName?: string;
  email: string;
  phone: string;
  companyName?: string;
  affiliateCode: string;
}): Promise<{ success: boolean; skipped?: boolean; status?: number; reason?: string }> {
  if (!(globalThis as { __BT10_DURABLE_GHL_AFFILIATE_OWNER__?: boolean }).__BT10_DURABLE_GHL_AFFILIATE_OWNER__) {
    return {
      success: false,
      skipped: true,
      reason: "durable_ghl_projection_required",
    };
  }
  if (!isGhlReady()) return { success: false, skipped: true, reason: "ghl_not_configured" };

  const apiKey = process.env.GHL_PRIVATE_INTEGRATION_TOKEN || process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!apiKey || !locationId) return { success: false, skipped: true, reason: "ghl_not_configured" };

  try {
    const payload = {
      locationId,
      firstName: params.firstName,
      lastName: params.lastName || "",
      email: params.email,
      phone: params.phone,
      companyName: params.companyName || "",
      tags: ["LB-AFFILIATE", "src_website", "lead_affiliate_signup"],
      customFields: [
        { key: "lb_lead_source", field_value: "affiliate" },
        { key: "lb_affiliate_code", field_value: params.affiliateCode },
      ],
    };

    // C-10 (#1626): full pause-authority protocol around the raw GHL mutation
    const gated = await gatedGhlMutation("affiliate_contact_create", () =>
      fetch("https://services.leadconnectorhq.com/contacts/", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Version": "2021-07-28",
        },
        body: JSON.stringify(payload),
      }),
    );
    if (!gated.ok) {
      console.warn(`[GHL Form Sync] Affiliate sync skipped — pause authority denied (${gated.reason})`);
      return { success: false, skipped: true, reason: gated.reason };
    }
    const response = gated.result;

    // C-10 (#1626): check HTTP status — do not swallow failures silently.
    // Log lines use affiliate code / GHL ID only, never the affiliate email.
    if (!response.ok) {
      console.error(`[GHL Form Sync] Affiliate contact POST failed: HTTP ${response.status} (affiliateCode=${params.affiliateCode})`);
      return { success: false, status: response.status, reason: `http_${response.status}` };
    }
    const result = await response.json();
    const ghlId = result.contact?.id;
    if (ghlId) {
      console.log(`[GHL Form Sync] Affiliate (code=${params.affiliateCode}) synced to GHL as ${ghlId}`);
    }
    return { success: true };
  } catch (err: any) {
    console.error(`[GHL Form Sync] Affiliate sync failed (affiliateCode=${params.affiliateCode}):`, err.message);
    return { success: false, reason: err.message };
  }
}

function getSourceTag(source: LeadSourceType): string | null {
  const tagMap: Record<LeadSourceType, string> = {
    free_analysis: "LB-QUIZ-LEAD",
    get_started: "LB-QUIZ-LEAD",
    statement_upload: "LB-STATEMENT-RECEIVED",
    merchant_application: "LB-MERCHANT-APP",
    support: "LB-SUPPORT",
    affiliate: "LB-AFFILIATE",
    cost_quiz: "LB-QUIZ-LEAD",
    estimate: "LB-ESTIMATE",
    callback: "LB-CALLBACK",
    equipment_order: "LB-EQUIPMENT-ORDER",
  };
  return tagMap[source] || null;
}

function getInboundWorkflowId(source: LeadSourceType): string | null {
  const envMap: Record<string, string | undefined> = {
    free_analysis: process.env.GHL_WORKFLOW_INBOUND_LEAD,
    get_started: process.env.GHL_WORKFLOW_INBOUND_LEAD,
    statement_upload: process.env.GHL_WORKFLOW_STATEMENT_REVIEW,
    merchant_application: process.env.GHL_WORKFLOW_MERCHANT_APP,
    support: process.env.GHL_WORKFLOW_SUPPORT_TICKET,
    affiliate: process.env.GHL_WORKFLOW_AFFILIATE_WELCOME,
    estimate: process.env.GHL_WORKFLOW_INBOUND_LEAD,
    callback: process.env.GHL_WORKFLOW_CALLBACK,
    equipment_order: process.env.GHL_WORKFLOW_EQUIPMENT_ORDER,
    cost_quiz: process.env.GHL_WORKFLOW_INBOUND_LEAD,
  };
  return envMap[source] || null;
}

async function setGhlDnd(ghlContactId: string, channel: "sms" | "email", dndActive: boolean): Promise<{ success: boolean; skipped?: boolean; status?: number; reason?: string }> {
  const apiKey = process.env.GHL_PRIVATE_INTEGRATION_TOKEN || process.env.GHL_API_KEY;
  if (!apiKey) return { success: false, skipped: true, reason: "ghl_not_configured" };

  const dndPayload: Record<string, unknown> = {
    dnd: dndActive,
    dndSettings: {
      [channel === "sms" ? "SMS" : "Email"]: {
        status: dndActive ? "active" : "inactive",
        message: dndActive
          ? `No ${channel} consent from form submission`
          : `${channel} consent granted via form submission`,
      },
    },
  };

  try {
    // C-10 (#1626): full pause-authority protocol around the raw GHL mutation
    const gated = await gatedGhlMutation("dnd_update", () =>
      fetch(`https://services.leadconnectorhq.com/contacts/${ghlContactId}`, {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Version": "2021-07-28",
        },
        body: JSON.stringify(dndPayload),
      }),
    );
    if (!gated.ok) {
      console.warn(`[GHL DND] DND update skipped — pause authority denied (${gated.reason})`);
      return { success: false, skipped: true, reason: gated.reason };
    }
    const response = gated.result;
    // C-10 (#1626): status checked; raw provider response body is NOT logged
    // (it can echo contact PII) — status code only.
    if (!response.ok) {
      console.warn(`[GHL DND] Failed to set ${channel} DND: HTTP ${response.status}`);
      return { success: false, status: response.status, reason: `http_${response.status}` };
    }
    return { success: true };
  } catch (err: any) {
    console.error(`[GHL DND] Error setting ${channel} DND:`, err?.message ?? err);
    return { success: false, reason: err?.message ?? "unknown_error" };
  }
}
