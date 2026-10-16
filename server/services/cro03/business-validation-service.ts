/**
 * Business-intent compatibility projection.
 *
 * The public executor delegates to the current canonical selected-recipient
 * address owner. Historical generation/winner/hash references remain provenance;
 * neither an old authorization nor a second unused reservation purchases I/O.
 * Original validation operation/timestamp are projected without copying or
 * extending the receipt. Pending/ambiguous shared work remains visibly deferred.
 * No GET mutations, raw email in audit metadata, or outbound authorization.
 */

import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { unseal as unsealCandidateEvidence, type CandidateEvidenceEnvelope } from "./candidate-evidence-service";
import {
  authorizeCro03cBusinessValidation,
  reserveCro03cBusinessValidationOperation,
  settleCro03cProviderOperation,
} from "./live-execution";
import { stableCro03RecipeHash } from "./contracts";
import { assertProviderActivation } from "../provider-manifest";
import { hashCro03Evidence } from "./source-staging";
import { sanitizeAuditPayload } from "../audit-sanitizer";
import { validateEmailRaw, type ZeroBounceRawResponse } from "../sdr/zerobounce";

const rows = (result: any): any[] => result?.rows ?? result ?? [];

// ── ZeroBounce status → email_discovery_status mapping ────────────────────────

const ZB_STATUS_MAP: Record<string, string> = {
  valid: "provider_valid",
  invalid: "provider_invalid",
  catch_all: "provider_catch_all",
  unknown: "provider_unknown",
  spamtrap: "provider_spamtrap",
  abuse: "provider_invalid",
  do_not_mail: "provider_invalid",
};

function mapZbStatus(zbStatus: string): string {
  return ZB_STATUS_MAP[zbStatus.toLowerCase()] ?? "provider_unknown";
}

// ── ZeroBounce HTTP client ─────────────────────────────────────────────────────

// ── Execution context for authorization gate ───────────────────────────────────

export interface BusinessValidationContext {
  commandId: string;
  runId: string;
  generationId: string;
  activationRevision: number;
  runtimeAttestationId: string;
  expiresAt: Date | string;
}

/**
 * Test-only transport injection point, mirroring the same pattern already
 * used by the contact-bound sibling (`processValidationIntent`'s
 * `ValidationIntentWorkerDeps`). Production callers never pass this — the
 * real `validateEmailRaw` HTTP client (hardcoded to api.zerobounce.net) is
 * used by default. Disposable certification uses it to prove the full
 * command→receipt→master_leads chain without any real network call.
 */
export type BusinessValidationWorkerDeps = {
  validateEmail?: typeof validateEmailRaw;
};

// ── processBusinessValidationIntent ───────────────────────────────────────────

/**
 * Execute one compatibility intent through the common address owner, then
 * CAS-project an original receipt. Legacy command approval is not selection.
 */
export async function processBusinessValidationIntent(
  intentId: string,
  _ctx: BusinessValidationContext,
  operationId?: string,
  deps: BusinessValidationWorkerDeps = {},
): Promise<"completed" | "deferred" | "ambiguous" | "superseded" | "failed" | "not_found"> {
  const intent=rows(await db.execute(sql`SELECT * FROM business_validation_intents
    WHERE id=${intentId}::uuid AND state='pending'
      AND (claim_token IS NULL OR lease_expires_at<NOW())`))[0];
  if (!intent) return "not_found";
  const evidence=rows(await db.execute(sql`SELECT * FROM cro03c_candidate_evidence
    WHERE id=${String(intent.candidate_evidence_id)}::uuid`))[0];
  if (!evidence) return "failed";
  let email:string;
  try {
    email=unsealCandidateEvidence(String(evidence.field),{
      ciphertext:String(evidence.envelope_ciphertext),nonce:String(evidence.envelope_nonce),
      tag:String(evidence.envelope_tag),keyVersion:Number(evidence.envelope_key_version),
    });
  } catch { return "failed"; }
  const historicalHash=createHash("sha256").update(`email\0${email.trim().toLowerCase()}`).digest("hex");
  if (historicalHash!==String(intent.normalized_email_token_hash)) return "superseded";
  const {delegateSelectedAddressValidation}=await import("../provider-readiness-control");
  const result=await delegateSelectedAddressValidation({
    businessId:Number(intent.business_id),email,
    deps:deps.validateEmail ? {verifyEmail:async normalizedEmail=>{
      const response=await deps.validateEmail!(normalizedEmail,"disposable-injected-transport");
      if (response.error) return {provider:"zerobounce" as const,verifiedAt:new Date().toISOString(),
        status:"unknown" as const,reason:"parse_error" as const,outcome:"unavailable" as const};
      return {provider:"zerobounce" as const,verifiedAt:new Date().toISOString(),
        status:response.status==="valid" ? "valid" as const : response.status==="invalid"
          ? "invalid" as const : response.status==="unknown" ? "unknown" as const : "unsafe" as const,
        outcome:"completed" as const};
    }} : undefined,
  });
  if (!result.receipt) {
    await db.execute(sql`UPDATE business_validation_intents SET
      terminal_code='canonical_selection_or_validation_pending',next_attempt_at=NOW()+INTERVAL '5 minutes',
      updated_at=NOW() WHERE id=${intentId}::uuid AND state='pending'`);
    return "deferred";
  }
  const claimToken=randomUUID();
  const claimed=rows(await db.execute(sql`UPDATE business_validation_intents SET
    state='claimed',claim_token=${claimToken}::uuid,lease_expires_at=NOW()+INTERVAL '5 minutes',
    updated_at=NOW() WHERE id=${intentId}::uuid AND state='pending'
      AND (claim_token IS NULL OR lease_expires_at<NOW()) RETURNING id`));
  if (!claimed.length) return "deferred";
  const valid=result.receipt.outcome==="valid";
  await writeBusinessValidationResult({
    intentId,claimToken,businessId:Number(intent.business_id),email:valid ? email : null,
    discoveryStatus:valid ? "provider_valid" : "provider_invalid",zbStatus:valid ? "valid" : "invalid",
    normalizedEmailHash:historicalHash,originalObservedAt:result.receipt.observedAt,
    originalOperationId:result.receipt.operationId,
  });
  // Release the old dispatcher's UNUSED reservation. The shared owner recorded
  // the only physical operation; this is not a second billable legacy dispatch.
  return operationId ? "deferred" : "completed";
}

/** Historical protocol implementation; not an execution entry point. */
async function processLegacyBusinessValidationIntent(
  intentId: string,
  ctx: BusinessValidationContext,
  /** operationId from reserveCro03cBusinessValidationOperation — used to write dispatch checkpoints. */
  operationId?: string,
  deps: BusinessValidationWorkerDeps = {},
): Promise<"completed" | "deferred" | "ambiguous" | "superseded" | "failed" | "not_found"> {
  const validateEmail = deps.validateEmail ?? validateEmailRaw;
  // ── Transport kill switch (mirrors assertCro03cAuthorityBeforeIo) ────────
  // Must check before any DB claim or I/O, matching the global CRO03 transport gate.
  if (process.env.CRO03_PROVIDER_TRANSPORT_ENABLED !== "true") {
    return "deferred";
  }

  const apiKey = process.env.ZEROBOUNCE_API_KEY ?? process.env.ZEROBOUNCE_APi_KEY;
  if (!apiKey) return "deferred";

  // ── Step 1: Read intent (no state change yet) ─────────────────────────────
  const intentRows = rows(await db.execute(sql`
    SELECT id, business_id, candidate_evidence_id, normalized_email_token_hash,
           state, approval_required, claim_token
      FROM business_validation_intents
     WHERE id = ${intentId}::uuid
       AND state = 'pending'
       AND approval_required = FALSE
       AND (claim_token IS NULL OR lease_expires_at < NOW())
  `));
  const intent = intentRows[0];
  if (!intent) return "not_found";

  // ── Step 2: Decrypt candidate email ──────────────────────────────────────
  let email: string;
  try {
    const evidenceRow = rows(await db.execute(sql`
      SELECT envelope_ciphertext, envelope_nonce, envelope_tag, envelope_key_version, field
        FROM cro03c_candidate_evidence
       WHERE id = ${String(intent.candidate_evidence_id)}::uuid
       LIMIT 1
    `))[0];
    if (!evidenceRow) return "failed";
    email = unsealCandidateEvidence(String(evidenceRow.field), {
      ciphertext: String(evidenceRow.envelope_ciphertext),
      nonce: String(evidenceRow.envelope_nonce),
      tag: String(evidenceRow.envelope_tag),
      keyVersion: Number(evidenceRow.envelope_key_version),
    } as CandidateEvidenceEnvelope);
  } catch {
    return "failed";
  }

  // ── Step 3: Verify hash ───────────────────────────────────────────────────
  const normalizedEmailHash = createHash("sha256")
    .update(`email\0${email.toLowerCase().trim()}`)
    .digest("hex");
  if (normalizedEmailHash !== String(intent.normalized_email_token_hash)) {
    return "failed"; // Don't permanently fail the intent — may be a transient mismatch.
  }

  // ── Step 4a: Provider-manifest activation check (pre-claim) ─────────────
  // assertProviderActivation is the provider-manifest allowlist gate.
  // Must succeed BEFORE any state change (before claim) so a temporary manifest
  // failure leaves the intent in 'pending' state, eligible for retry.
  // Mirrors live-provider-executors.ts assertProviderActivation() placement.
  try {
    assertProviderActivation({
      sourceId: "zerobounce",
      caller: "server/services/cro03/business-validation-service.ts",
      explicitPaidApproval: true,
    });
  } catch {
    // Provider not in manifest or not activated — definitively pre-I/O.
    // Intent remains pending for retry.
    return "deferred";
  }

  // ── Step 4b: Authorization gate (intent still 'pending') ─────────────────
  // Kill line: authorizeCro03cBusinessValidation writes an auth row before I/O.
  // The authorization query requires bvi.state = 'pending' — we have NOT changed state.
  try {
    await authorizeCro03cBusinessValidation({
      businessIntentId: intentId,
      commandId: ctx.commandId,
      runId: ctx.runId,
      generationId: ctx.generationId,
      activationRevision: ctx.activationRevision,
      businessId: Number(intent.business_id),
      normalizedEmailHash,
      runtimeAttestationId: ctx.runtimeAttestationId,
      expiresAt: ctx.expiresAt,
    });
  } catch {
    // Authorization denied — definitively pre-I/O; no charge possible.
    // Return "deferred" so the dispatcher settles the reservation as "blocked"
    // with zero cost. The intent remains pending for retry when conditions improve.
    return "deferred";
  }

  // ── Step 5: Atomic claim (CAS) ────────────────────────────────────────────
  // Authorization committed above; now claim so only this worker calls ZeroBounce.
  const claimToken = randomUUID();
  const claimed = rows(await db.execute(sql`
    UPDATE business_validation_intents
       SET state = 'claimed', claim_token = ${claimToken}::uuid,
           lease_expires_at = NOW() + INTERVAL '5 minutes',
           attempt_count = attempt_count + 1, updated_at = NOW()
     WHERE id = ${intentId}::uuid
       AND state = 'pending'
       AND (claim_token IS NULL OR lease_expires_at < NOW())
     RETURNING id
  `));
  if (claimed.length === 0) {
    // Another worker claimed between authorization and here — that's fine.
    // The auth row we wrote is idempotent; return early.
    return "deferred";
  }

  // ── Step 6: Pre-transport authority fence ────────────────────────────────
  // Lightweight check that command/provider authority still holds after claim.
  // Covers the authorize-to-claim gap where cancelCro03cCommand could fire.
  // Does NOT replace the full authorization above — it is the final gate.
  const preTransport = rows(await db.execute(sql`
    SELECT c.state AS command_state, c.cancel_requested_at,
           pc.enabled AS provider_enabled, pc.circuit_state
      FROM cro03c_commands c
      JOIN cro03c_business_validation_authorizations a
        ON a.command_id = c.id AND a.business_validation_intent_id = ${intentId}::uuid
      JOIN provider_controls pc ON pc.provider = 'zerobounce'
     WHERE c.id = a.command_id
       AND c.state IN ('running', 'completed')
       AND c.cancel_requested_at IS NULL
       AND pc.enabled = TRUE AND pc.circuit_state = 'closed'
     LIMIT 1
  `))[0];
  if (!preTransport) {
    // Command was cancelled or provider disabled in the gap — definitively pre-I/O.
    // Unclaim and abort. Return "superseded" so dispatcher settles as "blocked" (zero cost).
    await db.execute(sql`
      UPDATE business_validation_intents
         SET state = 'superseded', updated_at = NOW(),
             claim_token = NULL, lease_expires_at = NULL
       WHERE id = ${intentId}::uuid AND claim_token = ${claimToken}::uuid
    `);
    return "superseded";
  }

  // ── Step 8: Durable transport checkpoint (mirrors live-worker.ts pattern) ──
  // Before ZeroBounce I/O, write a dispatch checkpoint so a process crash after
  // the fetch is recoverable as "ambiguous" rather than leaving a reserved operation
  // with no proof that a billable call may have occurred.
  //
  // Uses the same checkpoint invariant as live-worker.ts:
  //   pre_io → dispatching → [transport_started → dispatched] → transport_returned
  //
  // If operationId is not provided (legacy/test callers), checkpointing is skipped.
  if (operationId) {
    const attemptId = randomUUID();
    const checkpointHash = hashCro03Evidence({ provider: "zerobounce", intentId, operationId, attemptId });

    // CAS: transition 'not_dispatched' → 'dispatching'. Requires RETURNING success.
    // If cancellation quarantines the operation between the fence check and here,
    // the UPDATE affects 0 rows → abort pre-I/O (no charge possible yet).
    const dispatching = rows(await db.execute(sql`
      UPDATE cro03c_stage_operations
         SET attempt_id = ${attemptId}::uuid,
             dispatch_state = 'dispatching',
             pre_io_authorized_at = NOW()
       WHERE id = ${operationId}::uuid
         AND dispatch_state = 'not_dispatched'
         AND state = 'reserved'
       RETURNING id
    `));
    if (dispatching.length === 0) {
      // Operation was quarantined/cancelled between fence check and checkpoint —
      // abort pre-I/O. Unclaim the intent so it can be retried.
      await db.execute(sql`
        UPDATE business_validation_intents
           SET state = 'pending', claim_token = NULL, lease_expires_at = NULL,
               next_attempt_at = NOW() + INTERVAL '5 minutes', updated_at = NOW()
         WHERE id = ${intentId}::uuid AND claim_token = ${claimToken}::uuid
      `);
      return "superseded";
    }

    await db.execute(sql`
      INSERT INTO cro03c_dispatch_checkpoints
        (stage_operation_id, attempt_id, checkpoint, authority_hash)
      VALUES (${operationId}::uuid, ${attemptId}::uuid, 'pre_io', ${checkpointHash})
      ON CONFLICT (stage_operation_id, attempt_id, checkpoint) DO NOTHING
    `);

    // CAS: mark transport_may_have_been_invoked=TRUE. Requires RETURNING success.
    // From this point, any failure MUST be treated as "ambiguous" by recovery.
    const dispatched = rows(await db.execute(sql`
      UPDATE cro03c_stage_operations
         SET dispatch_state = 'dispatched',
             dispatched_at = NOW(),
             transport_may_have_been_invoked = TRUE
       WHERE id = ${operationId}::uuid
         AND dispatch_state = 'dispatching'
         AND state = 'reserved'
       RETURNING id
    `));
    if (dispatched.length === 0) {
      // Concurrent cancellation won the race between the two CAS steps.
      // State is now ambiguous — the operation may or may not reach ZeroBounce.
      // Leave intent claimed; return ambiguous so caller settles as quarantined.
      return "ambiguous";
    }

    await db.execute(sql`
      INSERT INTO cro03c_dispatch_checkpoints
        (stage_operation_id, attempt_id, checkpoint, authority_hash)
      VALUES (${operationId}::uuid, ${attemptId}::uuid, 'transport_started',
              ${hashCro03Evidence({ checkpointHash, transport: "may_have_been_invoked" })})
      ON CONFLICT (stage_operation_id, attempt_id, checkpoint) DO NOTHING
    `);
  }

  // ── Step 9: ZeroBounce HTTP call ─────────────────────────────────────────
  // Only reached after a committed authorization row, a durable claim, and
  // successful transport_started checkpoint. A transport failure here is "ambiguous"
  // since transport_may_have_been_invoked=TRUE is already durable.
  let zbResponse: ZeroBounceRawResponse;
  try {
    zbResponse = await validateEmail(email, apiKey);
  } catch (err: any) {
    // Post-dispatch transport failure — leave claimed to prevent duplicate I/O.
    // The caller settles as "ambiguous" so the accounting record is quarantined.
    // validateEmail (validateEmailRaw) already records this attempt's
    // outcome at the transport boundary — do not record it again here, or a
    // single failed request could count twice toward the alert threshold.
    return "ambiguous";
  }

  {
    // ZeroBounce can return HTTP 200 with a body-level error (invalid API
    // key, exhausted credits) — validateEmailRaw already records that case
    // as a failure; only report a clean success signal when there's no
    // body-level error, so validateEmailRaw's own failure record isn't
    // immediately overwritten by a bogus success reset.
    const bodyError = typeof zbResponse.error === "string" && zbResponse.error.trim();
    if (!bodyError) {
      const { recordPaidProviderCreditSignal } = await import("../provider-credit-alert");
      await recordPaidProviderCreditSignal("zerobounce", { failure: false });
    }
  }

  const discoveryStatus = mapZbStatus(zbResponse.status);
  const isProviderValid = discoveryStatus === "provider_valid";

  // ── Step 10: transport_returned checkpoint + reconcile ───────────────────
  // After the provider returns, write the transport_returned checkpoint and CAS
  // the operation to 'reconciled'. This completes the durable transport protocol
  // (mirrors live-worker.ts: pre_io → dispatching → transport_started → dispatched
  // → transport_returned → reconciled). Without this, a successful operation retains
  // dispatch_state='dispatched' (transport may still be unresolved), which undermines
  // accounting/reconciliation evidence for successful calls.
  if (operationId) {
    // authority_hash must be a 64-hex-char sha256 (cro03c_dispatch_checkpoint_hash_chk);
    // md5() only produces 32 hex chars and violates that constraint. Postgres's
    // digest() also isn't guaranteed available (requires the pgcrypto extension),
    // so hash in JS with the same node:crypto helper the transport_started
    // checkpoint above uses, rather than depending on a DB extension.
    const stageOp = rows(await db.execute(sql`
      SELECT attempt_id FROM cro03c_stage_operations WHERE id = ${operationId}::uuid
    `))[0];
    if (stageOp?.attempt_id) {
      const returnedHash = hashCro03Evidence({
        stageOperationId: operationId, attemptId: String(stageOp.attempt_id), checkpoint: "transport_returned",
      });
      await db.execute(sql`
        INSERT INTO cro03c_dispatch_checkpoints
          (stage_operation_id, attempt_id, checkpoint, authority_hash)
        VALUES (${operationId}::uuid, ${String(stageOp.attempt_id)}::uuid, 'transport_returned', ${returnedHash})
        ON CONFLICT (stage_operation_id, attempt_id, checkpoint) DO NOTHING
      `);
    }
    await db.execute(sql`
      UPDATE cro03c_stage_operations
         SET dispatch_state = 'reconciled'
       WHERE id = ${operationId}::uuid
         AND dispatch_state = 'dispatched'
         AND state = 'reserved'
    `);
  }

  // ── Step 11: Write result (kill line: verify winner hash still current) ───
  await writeBusinessValidationResult({
    intentId,
    claimToken,
    businessId: Number(intent.business_id),
    email: isProviderValid ? email : null,
    discoveryStatus,
    zbStatus: zbResponse.status,
    normalizedEmailHash, // Used to re-verify winner hash before writing mainEmail.
  });

  return "completed";
}

// ── writeBusinessValidationResult ─────────────────────────────────────────────

interface WriteResultInput {
  originalObservedAt?: string;
  originalOperationId?: string;
  intentId: string;
  claimToken: string;
  businessId: number;
  email: string | null; // Null unless provider_valid (kill line).
  discoveryStatus: string;
  zbStatus: string;
  normalizedEmailHash: string; // Used to verify winner still matches before committing.
}

async function writeBusinessValidationResult(input: WriteResultInput): Promise<void> {
  const { intentId, claimToken, businessId, email, discoveryStatus, zbStatus, normalizedEmailHash } = input;

  let newStagingIntentId: string | null = null;
  await db.transaction(async (tx) => {
    // Step 1: Atomically transition the intent from 'claimed' → 'completed'.
    // Requiring state='claimed' prevents a cancelled/superseded intent from
    // committing its result after cancelCro03cCommand fires.
    const intentUpdated = rows(await tx.execute(sql`
      UPDATE business_validation_intents
         SET state = 'completed', disposition = ${discoveryStatus},
             completed_at = NOW(), updated_at = NOW(),
             claim_token = NULL, lease_expires_at = NULL
       WHERE id = ${intentId}::uuid
         AND claim_token = ${claimToken}::uuid
         AND state = 'claimed'
       RETURNING id
    `));
    if (intentUpdated.length === 0) {
      // Intent was superseded or cancelled between authorization and result commit.
      // Do NOT write business fields — the result is stale. Fail silently.
      return;
    }

    // Step 2: Re-verify winner hash still matches (FOR UPDATE to prevent races).
    const bizRow = rows(await tx.execute(sql`
      SELECT id, email_selected_candidate_hash
        FROM businesses WHERE id = ${businessId} FOR UPDATE
    `))[0];
    if (!bizRow || String(bizRow.email_selected_candidate_hash) !== normalizedEmailHash) {
      // Winner was replaced by a newer generation — the intent is completed
      // (it ran) but we do NOT write business fields from the stale result.
      return;
    }

    // Step 3: Write business fields.
    // Kill line: businesses.mainEmail ONLY written if provider_valid.
    // Non-valid results (catch_all, invalid, spamtrap, unknown) must clear main_email
    // to prevent downstream consumers from using an address whose latest validation
    // is not provider_valid (e.g. a prior valid→catch_all transition).
    if (email) {
      await tx.execute(sql`
        UPDATE businesses
           SET email_discovery_status = ${discoveryStatus},
               email_validation_updated_at = ${input.originalObservedAt ?? new Date().toISOString()}::timestamptz,
               main_email = ${email},
               updated_at = NOW()
         WHERE id = ${businessId}
      `);
    } else {
      await tx.execute(sql`
        UPDATE businesses
           SET email_discovery_status = ${discoveryStatus},
               email_validation_updated_at = ${input.originalObservedAt ?? new Date().toISOString()}::timestamptz,
               main_email = NULL,
               updated_at = NOW()
         WHERE id = ${businessId}
      `);
    }

    // Audit log — kill line: no raw email in audit_logs.
    await tx.execute(sql`
      INSERT INTO audit_logs(user_id, action, entity_type, entity_key, details, actor_type, actor_id)
      VALUES ('system', 'business_email_validation_completed', 'business', ${String(businessId)},
              ${JSON.stringify(sanitizeAuditPayload({
                intentId,
                businessId,
                discoveryStatus,
                zbStatus,
                originalOperationId:input.originalOperationId ?? null,
                // No email field — kill line.
              }))}::jsonb,
              'system', 'cro03c_business_validation')
    `);

    // MI-07: Atomically insert a staging intent when result is provider_valid.
    // The intent row is consumed by the master-lead-stager BullMQ worker.
    // We resolve the generation_id through business_validation_intents → winner_selection → generation.
    // ON CONFLICT DO NOTHING prevents duplicate pending intents for the same business+generation.
    // The new intent ID is returned from the transaction so we can enqueue AFTER the tx commits.
    if (discoveryStatus === "provider_valid") {
      const genResult = (await tx.execute(sql`
        SELECT ws.generation_id
        FROM business_validation_intents bvi
        JOIN cro03c_email_winner_selections ws ON ws.id = bvi.winner_selection_id
        WHERE bvi.id = ${intentId}::uuid
          AND ws.generation_id IS NOT NULL
        LIMIT 1
      `)).rows as any[];

      if (genResult.length > 0) {
        const generationId = String(genResult[0].generation_id);
        const stagingIntentResult = (await tx.execute(sql`
          INSERT INTO master_lead_staging_intents
            (canonical_business_id, cro03_generation_id, status, created_at, updated_at)
          VALUES
            (${businessId}, ${generationId}::uuid, 'pending', NOW(), NOW())
          ON CONFLICT (canonical_business_id, cro03_generation_id) WHERE status = 'pending'
          DO NOTHING
          RETURNING id
        `)).rows as any[];

        // Capture intent ID here so we can enqueue after the transaction commits.
        if (stagingIntentResult.length > 0) {
          newStagingIntentId = String(stagingIntentResult[0].id);
        }
      }
    }
  });

  // Enqueue AFTER db.transaction() resolves — the row is now visible to the worker.
  // setImmediate is intentionally not used: we want the enqueue to run synchronously
  // relative to the caller so a successful validation always results in an enqueued job.
  if (newStagingIntentId) {
    try {
      const { requireQueueManagerReady, QUEUE_NAMES } = await import("../queue-manager");
      const qm = requireQueueManagerReady();
      const queue = qm.getQueue(QUEUE_NAMES.MASTER_LEAD_STAGER);
      if (queue) {
        await queue.add("stage", { intentId: newStagingIntentId }, {
          attempts: 5,
          backoff: { type: "exponential", delay: 15_000 },
          removeOnComplete: { count: 500 },
          removeOnFail: { count: 200 },
        });
      }
    } catch (err) {
      // QueueManager may not be ready in test environments — log and continue.
      // The recover-pending-intents schedule will catch the un-enqueued intent.
      console.error("[MasterLeadStager] Failed to enqueue staging intent:", err);
    }
  }
}

// ── Startup reconciliation for existing businesses.mainEmail values ───────────
// Scope: pre-MI-06 rows where mainEmail IS NOT NULL and email_discovery_status IS NULL.
//
// What this does:
//   Phase A: tags rows as 'discovered' so the UI shows a stable status.
//
// What this does NOT do (by design):
//   - Does NOT create encrypted candidate evidence for legacy plaintext emails.
//     The original evidence context (generation, provider stage) is unavailable
//     for pre-MI-06 rows. Creating synthetic evidence would be untraceable.
//   - Does NOT create winner selections or validation intents for Phase A rows.
//     These require a proper generation/command authority chain (MI-06 § Step 4-5).
//   - Legacy 'discovered' rows will be processed by the full-cohort validation
//     pipeline (MI-09) once a new command/generation is issued for each business.
//
// Phase B: for 'discovered' businesses that already have a winner selection (created
//   by the new pipeline after MI-06 deployed), create a validation intent if one is missing.
//   This handles the race where winner selection ran before intent creation completed.

export async function reconcileExistingBusinessEmails(): Promise<{ processed: number; errors: number }> {
  // Phase A: Mark pre-MI-06 rows as 'discovered' (mainEmail exists, no status yet).
  const untagged = rows(await db.execute(sql`
    SELECT id FROM businesses
     WHERE main_email IS NOT NULL
       AND email_discovery_status IS NULL
     LIMIT 500
  `));

  let processed = 0;
  let errors = 0;

  for (const biz of untagged) {
    try {
      // Kill line: clear main_email so legacy addresses cannot reach outreach until
      // winner selection + ZeroBounce validation completes. SDR consumers gate on
      // mainEmail IS NOT NULL — clearing here enforces the winner-only validation gate
      // for all pre-MI-06 rows without deleting them permanently.
      // Phase B below re-creates intents for any that already have winner evidence.
      await db.execute(sql`
        UPDATE businesses
           SET email_discovery_status = 'discovered',
               main_email = NULL,
               updated_at = NOW()
         WHERE id = ${Number(biz.id)}
           AND email_discovery_status IS NULL
      `);
      processed++;
    } catch {
      errors++;
    }
  }

  // Phase B: For 'discovered' businesses that now have a winner selection but
  // still lack an active intent, create the intent so ZeroBounce can proceed.
  // This handles the case where winner selection ran after the initial reconciliation.
  const needsIntent = rows(await db.execute(sql`
    SELECT b.id AS business_id, b.main_email, ws.id AS winner_selection_id,
           ws.candidate_evidence_id, ws.normalized_value_hash
      FROM businesses b
      JOIN cro03c_email_winner_selections ws ON ws.business_id = b.id
                                             AND ws.state = 'selected'
     WHERE b.main_email IS NOT NULL
       AND b.email_discovery_status = 'discovered'
       AND NOT EXISTS (
         SELECT 1 FROM business_validation_intents bvi
          WHERE bvi.business_id = b.id
            AND bvi.state NOT IN ('superseded','revoked','completed','failed')
       )
     LIMIT 100
  `));

  for (const row of needsIntent) {
    try {
      const email = String(row.main_email).toLowerCase().trim();
      const normalizedHash = createHash("sha256").update(`email\0${email}`).digest("hex");
      await db.execute(sql`
        INSERT INTO business_validation_intents
          (business_id, winner_selection_id, candidate_evidence_id,
           normalized_email_token_hash, purpose, state, approval_required)
        VALUES
          (${Number(row.business_id)}, ${String(row.winner_selection_id)}::uuid,
           ${String(row.candidate_evidence_id)}::uuid,
           ${normalizedHash}, 'cro03c_business_email', 'pending', FALSE)
        ON CONFLICT (business_id, normalized_email_token_hash, purpose)
          WHERE state NOT IN ('superseded','revoked','completed','failed')
        DO NOTHING
      `);
      processed++;
    } catch {
      errors++;
    }
  }

  return { processed, errors };
}

// ── Durable initial selection producer ────────────────────────────────────────
//
// After Serper/Outscraper/Apollo stages write candidate evidence for a business,
// this producer queries businesses that have staged candidates under a running
// generation but no winner selection yet, and calls selectEmailWinner() for each.
//
// This is the normal production trigger for the winner-selection path.
// It runs on every CRO03C_LIVE tick (from the queue worker), BEFORE intent dispatch.

export async function dispatchPendingWinnerSelections(opts?: {
  limit?: number;
}): Promise<{ triggered: number; errors: number }> {
  const limit = Math.min(opts?.limit ?? 10, 50);

  // Find businesses with staged email candidates under a running generation,
  // where no winner selection exists yet for that generation.
  const selectable = rows(await db.execute(sql`
    SELECT DISTINCT ce.business_id, ce.generation_id
      FROM cro03c_candidate_evidence ce
      JOIN businesses b ON b.id = ce.business_id
      JOIN cro03c_generations g ON g.id = ce.generation_id
                                 AND g.state IN ('running', 'completed')
      JOIN cro03c_runs r ON r.id = g.run_id AND r.state IN ('running', 'completed')
      JOIN cro03c_commands c ON c.id = g.command_id AND c.state IN ('running', 'completed')
                              AND c.cancel_requested_at IS NULL AND c.expires_at > NOW()
     WHERE ce.field = 'email'
       AND ce.disposition IN ('staged', 'quarantined')
       AND ce.business_id IS NOT NULL
       -- Gate is generation-scoped: a prior generation's terminal business status
       -- does NOT suppress winner selection for a newer generation that has staged
       -- candidates. A later generation may have higher-confidence evidence that
       -- supersedes the prior result. The per-(business_id, generation_id) check below
       -- is the sole eligibility gate; no global email_discovery_status filter here.
       AND NOT EXISTS (
         SELECT 1 FROM cro03c_email_winner_selections ws
          WHERE ws.business_id = ce.business_id
            AND ws.generation_id = ce.generation_id
       )
     LIMIT ${limit}
  `));

  let triggered = 0;
  let errors = 0;

  for (const row of selectable) {
    try {
      const { selectEmailWinner } = await import("./candidate-selector");
      await selectEmailWinner(Number(row.business_id), String(row.generation_id));
      triggered++;
    } catch {
      errors++;
    }
  }

  return { triggered, errors };
}

// ── Durable producer: dispatch pending business validation intents ─────────────
//
// Called from the CRO03C_LIVE queue worker on every tick (after dispatchCro03cLive).
// Finds pending business_validation_intents (approval_required=FALSE, state='pending',
// next_attempt_at <= NOW()), loads the active command/generation/attestation context
// from the winner selection, and calls processBusinessValidationIntent().
//
// This is the production dispatch path. Winner selection is triggered separately
// (manually via POST /trigger-winner-selection in Phase 2, or by a future automation
// in Phase 5+). Once intents exist and approval_required=FALSE, this function runs them.

export async function dispatchPendingBusinessValidationIntents(opts?: {
  limit?: number;
}): Promise<{ dispatched: number; errors: number }> {
  const limit = Math.min(opts?.limit ?? 10, 50);

  // Load pending intents with their full command authority context and price schedule.
  // We join through winner_selection → generation → run → command → attestation → policy.
  const pending = rows(await db.execute(sql`
    SELECT bvi.id AS intent_id,
           bvi.business_id,
           bvi.attempt_count,
           ws.generation_id,
           g.id AS gen_id,
           g.run_id,
           g.command_id,
           c.activation_revision,
           c.runtime_attestation_id,
           t.expires_at AS attestation_expires_at,
           a.price_schedules
      FROM business_validation_intents bvi
      JOIN cro03c_email_winner_selections ws ON ws.id = bvi.winner_selection_id
                                              AND ws.state = 'selected'
      JOIN cro03c_generations g ON g.id = ws.generation_id
                                 AND g.state IN ('running', 'completed')
      JOIN cro03c_runs r ON r.id = g.run_id AND r.state IN ('running', 'completed')
      JOIN cro03c_commands c ON c.id = g.command_id AND c.state IN ('running', 'completed')
                              AND c.cancel_requested_at IS NULL AND c.expires_at > NOW()
      JOIN cro03c_runtime_attestations t ON t.id = c.runtime_attestation_id
                                         AND t.expires_at > NOW()
                                         AND t.db_healthy = TRUE AND t.redis_healthy = TRUE
      JOIN cro03c_activation_policies a ON a.id = c.activation_policy_id
     WHERE bvi.state = 'pending'
       AND bvi.approval_required = FALSE
       AND bvi.next_attempt_at <= NOW()
     ORDER BY bvi.next_attempt_at ASC
     LIMIT ${limit}
  `));

  let dispatched = 0;
  let errors = 0;

  for (const row of pending) {
    let operationId: string | null = null;
    try {
      // ── Step 1: Load price schedule for ZeroBounce ──────────────────────
      const priceSchedules = (row.price_schedules ?? {}) as Record<string, any>;
      const zbSchedule = priceSchedules["zerobounce"];
      if (!zbSchedule || !zbSchedule.version || !zbSchedule.amountMicros) {
        // No active ZeroBounce price schedule — skip; will retry when policy is updated.
        errors++;
        continue;
      }
      const priceScheduleHash = stableCro03RecipeHash(zbSchedule);

      // ── Step 2: Reserve stage_operations row (atomic per-attempt identity) ─
      // reserveCro03cBusinessValidationOperation() locks the intent row FOR UPDATE
      // inside its transaction, counts existing ops, and allocates a fresh attempt key.
      // No external COUNT(*) is needed — attempt identity is derived atomically.
      const reservation = await reserveCro03cBusinessValidationOperation({
        generationId: String(row.gen_id),
        intentId: String(row.intent_id),
        commandId: String(row.command_id),
        activationRevision: Number(row.activation_revision),
        priceScheduleVersion: Number(zbSchedule.version),
        priceScheduleHash,
        amountMicros: Number(zbSchedule.amountMicros),
      });
      operationId = reservation.operationId;
      const nextAttempt = reservation.attemptNumber;

      // ── Step 3: Execute business validation (auth → claim → ZeroBounce) ─
      const ctx: BusinessValidationContext = {
        commandId: String(row.command_id),
        runId: String(row.run_id),
        generationId: String(row.gen_id),
        activationRevision: Number(row.activation_revision),
        runtimeAttestationId: String(row.runtime_attestation_id),
        expiresAt: new Date(String(row.attestation_expires_at)),
      };
      const bizStatus = await processBusinessValidationIntent(String(row.intent_id), ctx, operationId);

      // ── Step 4: Settle stage_operations row with terminal receipt ────────
      // "ambiguous" = ZeroBounce transport failed after dispatch (request may have
      //   incurred a charge); settle as ambiguous/quarantined for manual reconciliation.
      // "deferred"/"superseded" = pre-I/O exit (auth failed, command cancelled);
      //   settle as blocked with zero cost.
      // "completed" = ZeroBounce completed; settle as success.
      const { hashCro03Evidence } = await import("./source-staging");
      // "failed"/"not_found" are definitively pre-I/O (missing evidence, hash mismatch,
      // ineligible intent) — billing is zero, settle as blocked, not ambiguous.
      const outcome = bizStatus === "completed" ? "success"
        : bizStatus === "ambiguous" ? "ambiguous"
        : bizStatus === "deferred" ? "blocked"
        : bizStatus === "superseded" ? "blocked"
        : bizStatus === "failed" ? "blocked"
        : bizStatus === "not_found" ? "blocked"
        : "blocked";
      const settledUnits = outcome === "success" ? 1 : 0;
      const settledAmountMicros = settledUnits * Number(zbSchedule.amountMicros);
      const billingCertainty: "certain" | "ambiguous" | "unknown" | "none" =
        outcome === "ambiguous" ? "ambiguous" : "none";
      await settleCro03cProviderOperation({
        operationId,
        outcome,
        settledUnits,
        settledAmountMicros,
        billingCertainty,
        evidenceHash: hashCro03Evidence({ provider: "zerobounce", outcome, intentId: String(row.intent_id), status: bizStatus, attempt: nextAttempt }),
        metadata: { provider: "zerobounce", outcome, bizStatus, intentId: String(row.intent_id), attempt: nextAttempt },
      });

      if (bizStatus === "completed") dispatched++;
    } catch {
      // If we created a stage_operations row, settle it as ambiguous so reconciliation can audit it.
      if (operationId) {
        try {
          const { hashCro03Evidence } = await import("./source-staging");
          await settleCro03cProviderOperation({
            operationId,
            outcome: "ambiguous",
            settledUnits: 0,
            settledAmountMicros: 0,
            billingCertainty: "ambiguous",
            evidenceHash: hashCro03Evidence({ provider: "zerobounce", outcome: "ambiguous", error: "dispatch_exception" }),
            metadata: { provider: "zerobounce", outcome: "ambiguous", error: "dispatch_exception" },
          });
        } catch { /* settle-on-error is best-effort */ }
      }
      errors++;
    }
  }

  return { dispatched, errors };
}

// ── Durable retry producer for DNS-indeterminate businesses ───────────────────
//
// When selectEmailWinner() sets email_discovery_status='dns_indeterminate', the
// staged candidates are left unchanged for retry. This function finds those
// businesses and re-triggers winner selection under the current active generation.
// Called from the CRO03C_LIVE queue worker alongside dispatchPendingBusinessValidationIntents.

export async function dispatchDnsIndeterminateRetries(opts?: {
  limit?: number;
}): Promise<{ triggered: number; errors: number }> {
  const limit = Math.min(opts?.limit ?? 5, 20);

  // Find businesses in dns_indeterminate state that still have staged candidates
  // and an active running generation.
  const retryable = rows(await db.execute(sql`
    SELECT DISTINCT b.id AS business_id, g.id AS generation_id
      FROM businesses b
      JOIN cro03c_candidate_evidence ce ON ce.business_id = b.id
                                       AND ce.field = 'email'
                                       AND ce.disposition = 'staged'
      JOIN cro03c_generations g ON g.id = ce.generation_id
                                 AND g.state IN ('running', 'completed')
      JOIN cro03c_runs r ON r.id = g.run_id AND r.state IN ('running', 'completed')
      JOIN cro03c_commands c ON c.id = g.command_id AND c.state IN ('running', 'completed')
                              AND c.cancel_requested_at IS NULL AND c.expires_at > NOW()
     WHERE b.email_discovery_status = 'dns_indeterminate'
       AND NOT EXISTS (
         SELECT 1 FROM cro03c_email_winner_selections ws
          WHERE ws.business_id = b.id AND ws.generation_id = g.id
       )
     LIMIT ${limit}
  `));

  let triggered = 0;
  let errors = 0;

  for (const row of retryable) {
    try {
      const { selectEmailWinner } = await import("./candidate-selector");
      await selectEmailWinner(Number(row.business_id), String(row.generation_id));
      triggered++;
    } catch {
      errors++;
    }
  }

  return { triggered, errors };
}

// ── Stale email status background job ─────────────────────────────────────────

/**
 * Reclaim expired `claimed` business validation intents back to `pending` when
 * the worker that claimed them crashed before dispatching.
 *
 * Recovery rules (conservative):
 *  - If the associated stage_operation is NOT yet dispatched
 *    (dispatch_state IN ('not_dispatched','dispatching') and
 *     transport_may_have_been_invoked = FALSE): pre-I/O crash, safe to retry.
 *    Reset intent to pending, clear claim fields.
 *  - If transport_may_have_been_invoked = TRUE: ambiguous. Leave the operation
 *    for the existing ambiguous-settlement path in the live worker; do not reset.
 *
 * Called before dispatchPendingBusinessValidationIntents() on every tick so
 * stranded pre-I/O claims are recovered within one tick.
 */
export async function reclaimExpiredBusinessValidationClaims(
  opts?: { limit?: number },
): Promise<{ reclaimed: number }> {
  const limit = Math.min(opts?.limit ?? 20, 100);
  // Identify the matching stage_operation for each expired claimed intent using the
  // operation_key pattern written by reserveCro03cBusinessValidationOperation():
  //   'cro03c:biz-validation:<intentId>:<attemptNumber>'
  // Only reset intents whose associated operation has NOT yet had transport invoked
  // (pre-I/O crash). Ambiguous post-I/O claims are left for the live-worker recovery path.
  // LATERAL join to latest operation only — prevents a stale pre-I/O attempt-1 row
  // from satisfying the pre-I/O check when attempt-2 has already dispatched (and
  // possibly invoked transport). Binding to the LATEST operation by created_at means
  // reclaim is only safe when the most-recent attempt for this intent is provably
  // pre-I/O, not just any historical attempt.
  const result = rows(await db.execute(sql`
    UPDATE business_validation_intents bvi
       SET state = 'pending',
           claim_token = NULL,
           lease_expires_at = NULL,
           attempt_count = bvi.attempt_count + 1,
           next_attempt_at = NOW() + INTERVAL '60 seconds',
           updated_at = NOW()
     WHERE bvi.id IN (
             SELECT bvi2.id
               FROM business_validation_intents bvi2,
                    LATERAL (
                      SELECT op.transport_may_have_been_invoked, op.dispatch_state
                        FROM cro03c_stage_operations op
                       WHERE op.operation_key LIKE 'cro03c:biz-validation:' || bvi2.id::text || ':%'
                         AND op.provider = 'zerobounce'
                       ORDER BY op.created_at DESC
                       LIMIT 1
                    ) latest_op
              WHERE bvi2.state = 'claimed'
                AND bvi2.lease_expires_at < NOW()
                AND latest_op.transport_may_have_been_invoked = FALSE
                AND latest_op.dispatch_state IN ('not_dispatched', 'dispatching')
              ORDER BY bvi2.lease_expires_at ASC
              LIMIT ${limit}
           )
     RETURNING id
  `));
  return { reclaimed: result.length };
}

export async function markStaleBusinessEmails(opts?: { limit?: number }): Promise<{ marked: number }> {
  const limit = Math.min(opts?.limit ?? 50, 200);
  // Kill line: clear main_email when marking stale so SDR consumers' existing null
  // checks block outreach to stale/unvalidated addresses without requiring callers
  // to additionally check email_discovery_status.
  const result = rows(await db.execute(sql`
    UPDATE businesses
       SET email_discovery_status = 'stale',
           main_email = NULL,
           updated_at = NOW()
     WHERE id IN (
       SELECT id FROM businesses
        WHERE email_discovery_status = 'provider_valid'
          AND email_validation_updated_at < NOW() - INTERVAL '180 days'
        LIMIT ${limit}
     )
     RETURNING id
  `));
  return { marked: result.length };
}
