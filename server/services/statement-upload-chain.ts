/**
 * Statement Upload Chain — Full 11-Step Conversion Pipeline
 *
 * Each step is wrapped in an individual try/catch.
 * Failed steps are logged to audit_log but NEVER abort the chain —
 * the merchant's upload is always preserved and they always get a success response.
 */

import { storage } from "../storage";
import { ACTIVE_DEAL_STAGES, statementProposals } from "@shared/schema";
import { db } from "../db";
import { eq, sql } from "drizzle-orm";
import { updateCheckpoint, updateCommandFKs, markSucceeded, markRecoverableFailed } from "./statement-upload-idempotency";
import { advanceDealStage } from "./deal-stage-service";
import { onStatementReceived } from "./statement-acquisition";

export interface StatementUploadInput {
  contactId: number;
  dealId?: number | null;
  fileBuffer?: Buffer;
  fileName?: string;
  /** Opaque shared protected-object reference. Set by the command producer. */
  protectedObjectRef?: string;
  protectedObjectChecksum?: string;
  source: "website" | "merchant_portal" | "dashboard" | "portal-rate-review" | "token-upload";
  /** If provided, used to look up existing deal stages and update accordingly */
  businessName?: string;
  consentEmail?: boolean;
  /** Partner org resolved from referral attribution — applied to deal on creation/update */
  partnerOrgId?: number | null;
  /**
   * Document already created by the caller for this exact upload (same file).
   * When provided, Step 4 reuses this document instead of writing a second
   * physical file + document row — prevents duplicate statement documents
   * when the route persists its own document before invoking the chain
   * (e.g. merchant portal rate review).
   */
  existingDocumentId?: number;
  /**
   * Idempotency command ID from the statement_upload_commands table.
   * When provided, the chain persists checkpoints and marks the command
   * succeeded/failed on completion.  Do NOT call claimCommand again inside
   * the chain — the caller already claimed the slot.
   */
  commandId?: string;
  /**
   * Original Idempotency-Key (UUID v4) from the HTTP request header.
   * Stored in command checkpoints so that the canonical result can be
   * correlated back to the client-supplied key for observability.
   */
  requestId?: string;
  /** Queue-worker lease fence. HTTP handlers never set this. */
  commandLeaseToken?: string;
  /** Inbound authority receipt. Internal correlation only; never returned publicly. */
  inboundRequestId?: string;
}

export interface ChainStepResult {
  step: number;
  name: string;
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

export interface StatementUploadChainResult {
  contactId: number;
  dealId: number;
  documentId?: number;
  steps: ChainStepResult[];
  failedSteps: string[];
  allSuccess: boolean;
}

// Active stages that should be advanced to "Statement Received" on upload
const STAGES_TO_ADVANCE = ["New Lead", "Review In Progress"];

async function logStepFailure(
  dealId: number | null,
  step: number,
  stepName: string,
  error: string,
) {
  try {
    await storage.createAuditLog({
      action: "statement_chain_step_failed",
      entityType: "deal",
      entityId: dealId || 0,
      actorType: "system",
      details: { step, stepName, error, timestamp: new Date().toISOString() },
    });
  } catch (logErr) {
    console.error("[StatementChain] Failed to write audit log:", logErr);
  }
}

async function logChainSuccess(
  dealId: number,
  contactId: number,
  failedSteps: string[],
) {
  try {
    await storage.createAuditLog({
      action: "statement_chain_completed",
      entityType: "deal",
      entityId: dealId,
      actorType: "system",
      details: {
        contactId,
        failedSteps,
        allSuccess: failedSteps.length === 0,
        timestamp: new Date().toISOString(),
      },
    });
  } catch { /* non-critical */ }
}

function makeStep(
  step: number,
  name: string,
  success: boolean,
  error?: string,
  data?: Record<string, unknown>,
): ChainStepResult {
  if (!success) {
    console.error(`[StatementChain] Step ${step} (${name}) FAILED:`, error);
  } else {
    console.log(`[StatementChain] Step ${step} (${name}) OK${data ? ` — ${JSON.stringify(data)}` : ""}`);
  }
  return { step, name, success, error, data };
}

export async function runStatementUploadChain(
  input: StatementUploadInput,
): Promise<StatementUploadChainResult> {
  const steps: ChainStepResult[] = [];
  let dealId: number = input.dealId ?? 0;
  let documentId: number | undefined;
  const commandId = input.commandId;
  const commandLeaseToken = input.commandLeaseToken;

  console.log(`[StatementChain] Starting upload chain for contact #${input.contactId}, source=${input.source}${commandId ? `, commandId=${commandId}` : ""}`);

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 1 — Contact loaded (already created/resolved by caller; verify exists)
  // ────────────────────────────────────────────────────────────────────────────
  try {
    const contact = await storage.getContact(input.contactId);
    if (!contact) throw new Error("Contact not found");
    steps.push(makeStep(1, "Contact verified", true, undefined, { contactId: contact.id }));
    if (commandId) {
      await updateCheckpoint(commandId, {
        step: 1,
        contactId: contact.id,
        ...(input.requestId ? { requestId: input.requestId } : {}),
      }, commandLeaseToken).catch(() => {});
    }
  } catch (err: any) {
    steps.push(makeStep(1, "Contact verified", false, err.message));
    await logStepFailure(dealId || null, 1, "Contact verified", err.message);
    if (commandId) {
      await markRecoverableFailed(commandId, { error: err.message, failedStep: 1 }, commandLeaseToken).catch(() => {});
    }
    // Contact is critical — cannot proceed
    return {
      contactId: input.contactId,
      dealId: dealId,
      steps,
      failedSteps: steps.filter(s => !s.success).map(s => s.name),
      allSuccess: false,
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 2 — Company created or linked
  // ────────────────────────────────────────────────────────────────────────────
  let companyId: number | null = null;
  try {
    const contact = await storage.getContact(input.contactId);
    const companyName = input.businessName || contact?.companyName || "";
    if (companyName) {
      const normalizedName = companyName.trim().toLowerCase();
      const allCompanies = await storage.getCompanies?.() ?? [];
      const existing = allCompanies.find(
        (c: any) => (c.legalName || "").toLowerCase() === normalizedName
          || (c.dba || "").toLowerCase() === normalizedName,
      );
      if (existing) {
        companyId = existing.id;
        steps.push(makeStep(2, "Company linked", true, undefined, { companyId: existing.id, name: companyName }));
      } else if (companyName.length > 1) {
        const newCompany = await storage.createCompany({ legalName: companyName });
        companyId = newCompany.id;
        steps.push(makeStep(2, "Company created", true, undefined, { companyId: newCompany.id, name: companyName }));
      } else {
        steps.push(makeStep(2, "Company skipped", true, undefined, { reason: "No company name" }));
      }
    } else {
      steps.push(makeStep(2, "Company skipped", true, undefined, { reason: "No company name" }));
    }
  } catch (err: any) {
    steps.push(makeStep(2, "Company linked", false, err.message));
    await logStepFailure(dealId || null, 2, "Company linked", err.message);
    // Non-critical — continue
  }

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 3 — Deal created or advanced to "Statement Received"
  // ────────────────────────────────────────────────────────────────────────────
  try {
    if (input.dealId) {
      // Existing deal — advance stage if needed
      const existingDeal = await storage.getDeal(input.dealId);
      if (existingDeal) {
        dealId = existingDeal.id;
        const baseUpdates: any = {
          statementReceived: true,
          ...(companyId ? { companyId } : {}),
          ...(input.partnerOrgId && !existingDeal.partnerOrgId ? { partnerOrgId: input.partnerOrgId } : {}),
        };
        if (STAGES_TO_ADVANCE.includes(existingDeal.stage)) {
          await storage.updateDeal(dealId, baseUpdates);
          await advanceDealStage(dealId, "Statement Received", "statement_upload_chain", {
            reason: "Statement upload chain received a statement",
            actor: "system",
            expectedStage: existingDeal.stage,
          });
          steps.push(makeStep(3, "Deal stage advanced", true, undefined, {
            dealId, from: existingDeal.stage, to: "Statement Received",
          }));
        } else {
          await storage.updateDeal(dealId, baseUpdates);
          steps.push(makeStep(3, "Deal updated", true, undefined, {
            dealId, stage: existingDeal.stage, note: "Stage kept (already past Statement Received)",
          }));
        }
      } else {
        throw new Error(`Deal #${input.dealId} not found`);
      }
    } else {
      // Check for existing open deal for this contact
      const existingDeals = await storage.getDealsByContact(input.contactId);
      const openDeal = existingDeals.find(d =>
        (ACTIVE_DEAL_STAGES as readonly string[]).includes(d.stage) && !d.archivedAt,
      );
      if (openDeal) {
        dealId = openDeal.id;
        const updates: any = { statementReceived: true };
        if (companyId) updates.companyId = companyId;
        if (input.partnerOrgId && !openDeal.partnerOrgId) updates.partnerOrgId = input.partnerOrgId;
        await storage.updateDeal(dealId, updates);
        if (STAGES_TO_ADVANCE.includes(openDeal.stage)) {
          await advanceDealStage(dealId, "Statement Received", "statement_upload_chain", {
            reason: "Statement upload chain received a statement",
            actor: "system",
            expectedStage: openDeal.stage,
          });
        }
        steps.push(makeStep(3, "Existing deal updated", true, undefined, {
          dealId, stage: openDeal.stage, advanced: STAGES_TO_ADVANCE.includes(openDeal.stage),
        }));
      } else {
        // Create new deal in "Statement Received"
        const newDeal = await storage.createDeal({
          contactId: input.contactId,
          pipeline: "sales",
          stage: "Statement Received",
          statementReceived: true,
          leadSource: input.source === "website" ? "website" : input.source === "merchant_portal" ? "merchant_portal" : "dashboard",
          notes: `Statement uploaded via ${input.source}.`,
          ...(companyId ? { companyId } : {}),
          ...(input.partnerOrgId ? { partnerOrgId: input.partnerOrgId } : {}),
        });
        dealId = newDeal.id;
        steps.push(makeStep(3, "Deal created", true, undefined, {
          dealId, stage: "Statement Received",
        }));
      }
    }
    // Persist deal FK on command row after deal is resolved/created
    if (commandId && dealId) {
      await updateCommandFKs(commandId, { contactId: input.contactId, dealId }, commandLeaseToken).catch(() => {});
      await updateCheckpoint(commandId, { step: 3, dealId }, commandLeaseToken).catch(() => {});
    }
  } catch (err: any) {
    steps.push(makeStep(3, "Deal created/updated", false, err.message));
    await logStepFailure(dealId || null, 3, "Deal created/updated", err.message);
    // Non-critical — continue with whatever dealId we have
  }

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 4 — File attached to contact + deal
  // ────────────────────────────────────────────────────────────────────────────
  if (input.existingDocumentId) {
    // Caller already persisted the document for this upload — reuse it instead
    // of writing a duplicate file + document row.
    try {
      const existingDoc = await storage.getDocumentById(input.existingDocumentId);
      if (!existingDoc) throw new Error(`Existing document ${input.existingDocumentId} not found`);
      documentId = existingDoc.id;
      // Link the document to the resolved deal if the caller couldn't yet.
      if (dealId && !existingDoc.dealId) {
        await storage.updateDocument(existingDoc.id, { dealId }).catch(() => {});
      }
      steps.push(makeStep(4, "File attached", true, undefined, { documentId, reused: true }));
      if (commandId) {
        await updateCommandFKs(commandId, { documentId }, commandLeaseToken).catch(() => {});
        await updateCheckpoint(commandId, { step: 4, documentId, reused: true }, commandLeaseToken).catch(() => {});
      }
    } catch (err: any) {
      steps.push(makeStep(4, "File attached", false, err.message));
      await logStepFailure(dealId, 4, "File attached", err.message);
    }
  } else if (input.protectedObjectRef && input.fileName) {
    try {
      const safeFileName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
      const object = { objectRef: input.protectedObjectRef, checksumSha256: input.protectedObjectChecksum };
      const storageKey = object.objectRef;

      const doc = await storage.createDocument({
        type: "merchant_statement",
        category: "Processing Statement",
        fileName: safeFileName,
        fileSize: null,
        storageKey,
        dealId: dealId || null,
        contactId: input.contactId,
        accessScope: "internal",
        status: "pending",
        uploadedBy: `system:${input.source}`,
      });
      documentId = doc.id;
      steps.push(makeStep(4, "File attached", true, undefined, { documentId, storageKey }));
      if (commandId) {
        await updateCommandFKs(commandId, { documentId }, commandLeaseToken).catch(() => {});
        await updateCheckpoint(commandId, { step: 4, documentId }, commandLeaseToken).catch(() => {});
      }
    } catch (err: any) {
      steps.push(makeStep(4, "File attached", false, err.message));
      await logStepFailure(dealId, 4, "File attached", err.message);
    }
  } else {
      throw new Error("MISSING_PROTECTED_OBJECT");
  }

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 5 — AI analysis job queued  (lifecycle: pending → processing → complete)
  // ────────────────────────────────────────────────────────────────────────────
  if (dealId) {
    try {
      // Set pending immediately so the deal card reflects queued state
      await storage.updateDeal(dealId, { analysisStatus: "pending" });

      const { enqueueStatementAnalysis } = await import("./queue-manager");
      const jobId = await enqueueStatementAnalysis(dealId);
      if (!jobId) throw new Error("STATEMENT_ANALYSIS_QUEUE_UNAVAILABLE");

      steps.push(makeStep(5, "AI analysis queued", true, undefined, {
        dealId,
        analysisStatus: "pending",
        driver: "bullmq",
      }));
    } catch (err: any) {
      steps.push(makeStep(5, "AI analysis queued", false, err.message));
      await logStepFailure(dealId, 5, "AI analysis queued", err.message);
    }
  } else {
    steps.push(makeStep(5, "AI analysis queued", false, "No dealId available"));
    await logStepFailure(null, 5, "AI analysis queued", "No dealId");
  }

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 5b — Stop statement-chase sequence + advance lifecycle
  //
  // Called here (inside the chain) so ALL upload entry points — public website,
  // dashboard rep upload, merchant portal — reliably stop the chase without each
  // caller needing to remember to invoke it separately.
  // ────────────────────────────────────────────────────────────────────────────
  // Stopping the chase and advancing the lifecycle are local DB authority
  // writes; they must not be held behind provider readiness or the global
  // outbound pause.  Only the external delivery/projection steps below are
  // held.  This keeps every upload entry point from leaving a live chase
  // enrollment behind after the statement has arrived.
  try {
    await onStatementReceived(input.contactId, dealId || undefined);
    steps.push(makeStep(5.5, "Statement chase stopped", true, undefined, {
      state: "completed",
      externalAttempted: false,
    }));
  } catch (err: any) {
    steps.push(makeStep(5.5, "Statement chase stopped", false, err.message));
    await logStepFailure(dealId, 5.5, "Statement chase stopped", err.message);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 6 — Rep notified (in-app notification + email)
  // ────────────────────────────────────────────────────────────────────────────
  try {
    const contact = await storage.getContact(input.contactId);
    const deal = dealId ? await storage.getDeal(dealId) : null;
    const merchantName = input.businessName || contact?.companyName
      || `${contact?.firstName || ""} ${contact?.lastName || ""}`.trim()
      || "Unknown";

    // Resolve rep — priority order per task spec:
    //   1. contact.assignedTo (equivalent of contact.agentId owner)
    //   2. deal.owner
    //   3. ADMIN_EMAIL fallback
    // We look up each candidate against the users table so we get the user's
    // string id (required for recipientId) AND their email (for the rep email).
    let repUserId: string | null = null;   // users.id — used as recipientId
    let repEmail: string | null = null;
    let repName: string | null = null;

    try {
      const allUsers = await storage.getUsersByRole(["admin", "manager", "agent"]);

      const findUser = (ownerKey: string | null | undefined) => {
        if (!ownerKey) return null;
        return allUsers.find(u =>
          u.email === ownerKey
          || `${u.firstName || ""} ${u.lastName || ""}`.trim() === ownerKey,
        ) ?? null;
      };

      // 1. contact.assignedTo first (spec: "contact.agentId owner")
      let matched = findUser((contact as any)?.assignedTo);
      // 2. deal.owner as fallback
      if (!matched) matched = findUser(deal?.owner);
      // 3. ADMIN_EMAIL fallback
      if (!matched && process.env.ADMIN_EMAIL) {
        matched = allUsers.find(u => u.email === process.env.ADMIN_EMAIL) ?? null;
      }

      if (matched) {
        repUserId = matched.id;          // string user id — correct recipientId
        repEmail = matched.email ?? null;
        repName = `${matched.firstName || ""} ${matched.lastName || ""}`.trim() || matched.email || null;
      }
    } catch { /* non-fatal — fall through to ADMIN_EMAIL raw fallback */ }

    // Raw ADMIN_EMAIL fallback (no matching user row found)
    if (!repEmail) {
      repEmail = process.env.ADMIN_EMAIL || null;
      repName = "Admin";
      // recipientId stays null → notification is system-wide (visible to all admins)
    }

    const dealLink = dealId
      ? `${process.env.APP_URL || ""}/dashboard/deals/${dealId}`
      : `${process.env.APP_URL || ""}/dashboard/pipeline`;

    // In-app notification — recipientId MUST be the user's string id so that
    // getNotificationsPaginated(userId) correctly scopes it to that user's inbox.
    // When repUserId is null the notification is system-wide (recipientId IS NULL).
    await storage.createNotification({
      channel: "internal",
      title: "New Statement Uploaded",
      message: `${merchantName} uploaded a processing statement — ready for review.`,
      type: "alert",
      recipientId: repUserId ?? undefined,
      metadata: {
        contactId: input.contactId,
        dealId: dealId ?? undefined,
        link: dealLink,
        eventType: "statement_uploaded",
      },
    });

    steps.push(makeStep(6, "Rep notified", true, undefined, {
      repUserId: repUserId || "system-wide",
      channel: "in-app-only",
      externalDeliveryState: "held",
    }));
  } catch (err: any) {
    steps.push(makeStep(6, "Rep notified", false, err.message));
    await logStepFailure(dealId, 6, "Rep notified", err.message);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 7 — GHL projection requested for statement metadata
  // ────────────────────────────────────────────────────────────────────────────
  // Writes the durable, consumable handoff: the same idempotent pending contact projection the merchant application
  // path uses. The projection worker owns claims, retries, a missing GHL contact id (a wait, not a failure) and the
  // pause-gated provider write. This step is never reported as provider-complete. Replays reuse the one pending
  // projection and the same handoff identity.
  try {
    const handoffKey = `statement-projection:${input.contactId}:${documentId ?? input.inboundRequestId ?? "no-document"}`;
    const { enqueueGhlContactProjection } = await import("./ghl-form-sync");
    await enqueueGhlContactProjection(input.contactId);
    const existing = await db.execute(sql`
      SELECT 1 FROM audit_logs
      WHERE action = 'statement_projection_handoff_recorded' AND details->>'handoffKey' = ${handoffKey}
      LIMIT 1`);
    const alreadyRecorded = (((existing as any).rows ?? []) as unknown[]).length > 0;
    if (!alreadyRecorded) {
      await storage.createAuditLog({
        action: "statement_projection_handoff_recorded",
        entityType: "contact",
        entityId: input.contactId,
        actorType: "system",
        details: { handoffKey, documentId: documentId ?? null, dealId, providerWriteAttempted: false, state: "enqueued_pending_projection" },
      } as any);
    }
    steps.push(makeStep(7, "Projection handoff recorded", true, undefined, {
      state: "handed_off",
      handoffKey,
      reused: alreadyRecorded,
      consumableCommand: "contact_provider_projection:pending",
      providerWriteAttempted: false,
      providerComplete: false,
    }));
  } catch (err: any) {
    steps.push(makeStep(7, "Projection handoff recorded", false, err.message));
    await logStepFailure(dealId, 7, "Projection handoff recorded", err.message);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 8 — Pipeline stage confirmed "Statement Received"
  // ────────────────────────────────────────────────────────────────────────────
  try {
    if (dealId) {
      const deal = await storage.getDeal(dealId);
      if (deal && STAGES_TO_ADVANCE.includes(deal.stage)) {
        await advanceDealStage(dealId, "Statement Received", "statement_upload_chain_confirm", {
          reason: "Statement upload chain stage confirmation",
          actor: "system",
          expectedStage: deal.stage,
        });
        steps.push(makeStep(8, "Pipeline stage set", true, undefined, {
          dealId, from: deal.stage, to: "Statement Received",
        }));
      } else {
        steps.push(makeStep(8, "Pipeline stage verified", true, undefined, {
          dealId, stage: deal?.stage || "unknown",
        }));
      }
    } else {
      steps.push(makeStep(8, "Pipeline stage set", false, "No dealId"));
      await logStepFailure(null, 8, "Pipeline stage set", "No dealId");
    }
  } catch (err: any) {
    steps.push(makeStep(8, "Pipeline stage set", false, err.message));
    await logStepFailure(dealId, 8, "Pipeline stage set", err.message);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 9 — Merchant inbound confirmation (canonical enrollInInboundConfirmation)
  //
  // enrollInInboundConfirmation is the SOLE owner of merchant confirmation delivery.
  // It handles GHL workflow enrollment → direct email (GHL → SMTP) internally and
  // writes its own audit log entries for each outcome.  This step records whether
  // the canonical service was invoked and captures evidence of the outcome.
  //
  // The canonical service returns a typed, explicit outcome that is the SOLE
  // source of truth for delivery. This step consumes that outcome directly and
  // NEVER infers "sent"/"enrolled" from config/contact state or from the mere
  // fact that the Promise resolved.
  //
  // Outcome → step success mapping:
  //   "enrolled"        → success  (native GHL workflow trigger succeeded)
  //   "sent"            → success  (direct provider delivered the email)
  //   "skipped"         → FAILURE  (prerequisite missing; recoverable)
  //   "not_configured"  → FAILURE  (no delivery channel usable; recoverable)
  //   "failed"          → FAILURE  (explicit provider delivery failure)
  //   "unknown"         → FAILURE  (no definitive outcome; recoverable)
  //   thrown error      → FAILURE  (unexpected exception)
  // ────────────────────────────────────────────────────────────────────────────
  // The chain never sends and never enrolls. The single acknowledgement owner (inbound-acknowledgement.ts) prepares,
  // dispatches and settles the request's `transactional_ack` effect; this step only reports its current state.
  try {
    let ackState: string = "no_inbound_request";
    if (input.inboundRequestId) {
      const rows = await db.execute(sql`
        SELECT e.state AS effect_state, a.state AS ack_state, a.blocked_reason
        FROM inbound_request_effects e
        LEFT JOIN inbound_acknowledgements a ON a.effect_id = e.id
        WHERE e.request_id = ${input.inboundRequestId} AND e.effect_type = 'transactional_ack'
        LIMIT 1`);
      const row = (((rows as any).rows ?? []) as Array<{ effect_state: string; ack_state: string | null; blocked_reason: string | null }>)[0];
      ackState = row ? (row.ack_state ?? `effect_${row.effect_state}`) + (row.blocked_reason ? `:${row.blocked_reason}` : "") : "no_acknowledgement_effect";
    }
    steps.push(makeStep(9, "Acknowledgement owned by inbound effect", true, undefined, {
      owner: "inbound_acknowledgement",
      state: ackState,
      externalAttempted: false,
    }));
  } catch (err: any) {
    steps.push(makeStep(9, "Acknowledgement owned by inbound effect", false, err.message));
    await logStepFailure(dealId, 9, "Acknowledgement owned by inbound effect", err.message);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 10 — Proposal draft entity created (statement_proposals table)
  // ────────────────────────────────────────────────────────────────────────────
  try {
    if (dealId) {
      const deal = await storage.getDeal(dealId);
      const contact = await storage.getContact(input.contactId);
      const merchantName = input.businessName || contact?.companyName
        || `${contact?.firstName || ""} ${contact?.lastName || ""}`.trim()
        || "Merchant";

      // Upsert a dedicated proposal row in statement_proposals — concurrency-safe.
      // The unique partial index on deal_id (WHERE deal_id IS NOT NULL) guarantees
      // exactly one row per deal even when the upload chain and the AI analyzer race.
      // ON CONFLICT: update only upload-time metadata; preserve analyzer status/results.
      const upsertResult = await db.execute(sql`
        INSERT INTO statement_proposals
          (deal_id, contact_id, status, merchant_name, source, statement_file_name, plans, notes, created_at, updated_at)
        VALUES
          (${dealId}, ${input.contactId}, 'draft', ${merchantName}, ${input.source ?? null},
           ${input.fileName ?? null}, ${'[]'}::jsonb,
           'Statement received — awaiting AI analysis to populate pricing plans.',
           NOW(), NOW())
        ON CONFLICT (deal_id) WHERE deal_id IS NOT NULL
        DO UPDATE SET
          merchant_name      = CASE WHEN statement_proposals.status IN ('analyzed','failed')
                                    THEN statement_proposals.merchant_name
                                    ELSE EXCLUDED.merchant_name END,
          source             = COALESCE(statement_proposals.source, EXCLUDED.source),
          statement_file_name = COALESCE(statement_proposals.statement_file_name, EXCLUDED.statement_file_name),
          contact_id         = COALESCE(statement_proposals.contact_id, EXCLUDED.contact_id),
          updated_at         = NOW()
        RETURNING id
      `);
      const proposalRow = upsertResult.rows[0] as { id: number } | undefined;
      console.log(`[StatementChain] Step 10: upserted statement_proposals row #${proposalRow?.id} for deal #${dealId}`);

      // Also flag the deal so pipeline/deal-card UI can show a "Draft Proposal" badge.
      if (deal && (!deal.proposalStatus || deal.proposalStatus === "none")) {
        await storage.updateDeal(dealId, {
          proposalStatus: "draft",
          proposalGeneratedAt: new Date(),
        });
      }

      steps.push(makeStep(10, "Proposal draft created", true, undefined, {
        dealId,
        proposalId: proposalRow?.id,
        merchantName,
        table: "statement_proposals",
      }));
    } else {
      steps.push(makeStep(10, "Proposal draft created", false, "No dealId"));
      await logStepFailure(null, 10, "Proposal draft created", "No dealId");
    }
  } catch (err: any) {
    steps.push(makeStep(10, "Proposal draft created", false, err.message));
    await logStepFailure(dealId, 10, "Proposal draft created", err.message);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 11 — Follow-up sequence enrolled
  // ────────────────────────────────────────────────────────────────────────────
  steps.push(makeStep(11, "Follow-up sequence held", true, undefined, {
    contactId: input.contactId,
    dealId,
    enrollmentStatus: "held",
    externalAttempted: false,
  }));

  // ────────────────────────────────────────────────────────────────────────────
  // Summary
  // ────────────────────────────────────────────────────────────────────────────
  const failedSteps = steps.filter(s => !s.success).map(s => s.name);
  await logChainSuccess(dealId, input.contactId, failedSteps);

  if (failedSteps.length > 0) {
    console.warn(
      `[StatementChain] Chain completed with ${failedSteps.length} failed step(s): ${failedSteps.join(", ")}`,
    );
  } else {
    console.log(`[StatementChain] All 11 steps completed successfully for deal #${dealId}`);
  }

  const chainResult: StatementUploadChainResult = {
    contactId: input.contactId,
    dealId,
    documentId,
    steps,
    failedSteps,
    allSuccess: failedSteps.length === 0,
  };

  // ── Idempotency command lifecycle terminal update ──────────────────────────
  // Only the owner execution (the one that called claimCommand) marks terminal
  // state; replay and in-progress paths never run the chain at all.
  if (commandId) {
    const resultPayload: Record<string, unknown> = {
      contactId: input.contactId,
      dealId,
      documentId: documentId ?? null,
      failedSteps,
      allSuccess: chainResult.allSuccess,
    };
    if (chainResult.allSuccess) {
      await markSucceeded(commandId, resultPayload, commandLeaseToken).catch(err =>
        console.error("[StatementChain] markSucceeded failed:", err.message),
      );
    } else {
      // Non-fatal failures are still recoverable (chain completed but some steps failed)
      await markRecoverableFailed(commandId, { ...resultPayload, note: "Chain completed with step failures" }, commandLeaseToken).catch(err =>
        console.error("[StatementChain] markRecoverableFailed failed:", err.message),
      );
    }
  }

  return chainResult;
}
