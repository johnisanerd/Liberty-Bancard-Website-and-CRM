/**
 * BT-10 provider health and readiness authority.
 *
 * This module is deliberately narrow: it turns normalized provider evidence
 * into a purpose-aware decision. It never owns consent, identity, provenance,
 * classification, manual field authority, or GHL projections.
 */

import { randomUUID } from "crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { contacts, eligibilitySnapshots, providerObservations, validationIntents } from "@shared/schema";
import { CRO03C_CURRENT_MIGRATION_HEAD } from "./cro03/contracts";
import { currentCanonicalValidationSelection } from "./canonical-recipient-preparation";
import {
  claimCanonicalAddressValidation,bindCanonicalAddressOperation,
  markCanonicalAddressDispatch,releaseCanonicalAddressValidation,
} from "./canonical-address-validation";
import { findFreshProviderObservation,getActiveSfpOutreachPolicy } from "./cro03/sfp-outreach-policy";

export {
  decideMarketingEmailValidation,
  EMAIL_VALIDATION_MAX_AGE_MS,
  EMAIL_VALIDATION_POLICY_VERSION,
  hashEmailToken,
  normalizeEmailToken,
} from "./provider-readiness-decision";
import {
  decideMarketingEmailValidation,
  EMAIL_VALIDATION_MAX_AGE_MS,
  EMAIL_VALIDATION_POLICY_VERSION,
  hashEmailToken,
  type MarketingValidationDecision,
} from "./provider-readiness-decision";
export type {
  MarketingValidationDecision,
  MarketingValidationReason,
  ValidationEvidence,
} from "./provider-readiness-decision";

/**
 * Records exactly one recoverable validation intent for a contact generation.
 * It is transaction-friendly and does no provider or queue I/O.
 */
export async function createValidationIntent(
  tx: any,
  input: {
    contactId: number;
    email: string | null | undefined;
    generation: number;
    purpose?: string;
  },
): Promise<boolean> {
  const tokenHash = hashEmailToken(input.email);
  if (!tokenHash || input.generation < 1) return false;
  if (!await currentCanonicalValidationSelection(input.contactId,tokenHash,tx)) return false;
  const purpose = input.purpose ?? "marketing_outreach";
  await tx.insert(validationIntents).values({
    contactId: input.contactId,
    normalizedEmailTokenHash: tokenHash,
    subjectGeneration: input.generation,
    policyVersion: EMAIL_VALIDATION_POLICY_VERSION,
    purpose,
    state: "pending",
    enqueueState: "deferred",
  }).onConflictDoUpdate({
    target: [
      validationIntents.contactId,
      validationIntents.normalizedEmailTokenHash,
      validationIntents.subjectGeneration,
      validationIntents.purpose,
    ],
    set: {
      updatedAt: new Date(),
      state: sql`CASE WHEN validation_intents.state='completed' OR
        validation_intents.state='blocked' AND validation_intents.terminal_code IN
          ('canonical_target_selection_required','canonical_target_selection_stale','cro03c_authority_invalid')
        THEN 'pending' ELSE validation_intents.state END`,
      nextAttemptAt: sql`CASE WHEN validation_intents.state='completed' THEN NOW()
        ELSE validation_intents.next_attempt_at END`,
    },
  });
  return true;
}

/**
 * The read path used by marketing callers. Database errors are represented as
 * unavailable, never as a permissive fallback. A legacy status without a
 * matching current observation is deliberately insufficient.
 */
export async function evaluateMarketingEmailEligibility(contactId: number): Promise<MarketingValidationDecision> {
  try {
    const [contact] = await db.select({
      id: contacts.id,
      businessId: contacts.businessId,
      email: contacts.email,
      emailStatus: contacts.emailStatus,
      emailTokenHash: contacts.emailTokenHash,
      emailMutationGeneration: contacts.emailMutationGeneration,
      emailValidationUpdatedAt: contacts.emailValidationUpdatedAt,
    }).from(contacts).where(eq(contacts.id, contactId)).limit(1);
    if (!contact) {
      return { allowed: false, decision: "blocked", reason: "missing_email", emailTokenHash: null, subjectGeneration: null, evidenceAt: null };
    }
    // CRO-02 observes provider-pre-spend inputs through the shared adapter.
    // BT-10 remains the effective readiness authority in shadow mode.
    const { authorizeCommercialUse } = await import("./commercial-resolution");
    const commercial = await authorizeCommercialUse({
      subjectType: "contact",
      subjectId: contactId,
      effect: "provider_pre_spend",
    });
    const tokenHash = hashEmailToken(contact.email);
    const observation = tokenHash ? await findFreshProviderObservation({
      businessId:Number(contact.businessId ?? 0),emailTokenHash:tokenHash,
      ttlDays:EMAIL_VALIDATION_MAX_AGE_MS / 86_400_000,
    }) : null;
    return {
      ...decideMarketingEmailValidation(contact.email, {
      emailStatus: contact.emailStatus,
      emailTokenHash: observation ? tokenHash : null,
      subjectGeneration: contact.emailMutationGeneration,
      // A provider observation is the sole positive marketing authority.
      // Contacts.emailStatus remains a backwards-compatible delivery projection
      // and cannot authorize current marketing by itself.
      verifiedAt: observation?.observedAt,
      providerOutcome: observation?.outcome,
      addressReceipt: observation && tokenHash ? {
        operationId:observation.operationId,emailTokenHash:tokenHash,expiresAt:observation.expiresAt,
      } : null,
      }),
      ...(commercial.shadowDecision.snapshotId
        ? { commercialResolutionSnapshotId: commercial.shadowDecision.snapshotId }
        : {}),
    };
  } catch {
    return {
      allowed: false,
      decision: "unavailable",
      reason: "provider_unavailable",
      emailTokenHash: null,
      subjectGeneration: null,
      evidenceAt: null,
    };
  }
}

export async function persistMarketingEligibilitySnapshot(
  contactId: number,
  purpose: string,
  decision: MarketingValidationDecision,
): Promise<void> {
  if (decision.subjectGeneration == null) return;
  await db.insert(eligibilitySnapshots).values({
    contactId,
    purpose,
    policyVersion: EMAIL_VALIDATION_POLICY_VERSION,
    subjectGeneration: decision.subjectGeneration,
    decision: decision.decision,
    reasonCodes: [decision.reason],
    evidenceRefs: [],
    commercialResolutionSnapshotId: decision.commercialResolutionSnapshotId,
    expiresAt: decision.evidenceAt
      ? new Date(decision.evidenceAt.getTime() + EMAIL_VALIDATION_MAX_AGE_MS)
      : null,
  });
}

/** Explicit queue ownership: a missing producer means a recoverable deferred intent. */
export async function enqueueValidationIntent(intentId: string): Promise<boolean> {
  const candidate = (await db.execute(sql`SELECT contact_id,normalized_email_token_hash
    FROM validation_intents WHERE id=${intentId}::uuid AND state='pending'`) as any).rows?.[0];
  if (!candidate || !await currentCanonicalValidationSelection(
    Number(candidate.contact_id),String(candidate.normalized_email_token_hash),
  )) return false;
  try {
    const { getQueueManagerProducers, QUEUE_NAMES } = await import("./queue-manager");
    const manager = getQueueManagerProducers();
    // Task #1956 step 6: re-homed from QUEUE_NAMES.ENRICHMENT to
    // QUEUE_NAMES.ZEROBOUNCE_BATCH so validation-intent processing is
    // governed by the "email-validation" capability group, not "enrichment" —
    // an operator disabling enrichment should not also disable ZeroBounce
    // spend, and vice versa.
    const queue = manager?.getQueue(QUEUE_NAMES.ZEROBOUNCE_BATCH);
    if (!queue) {
      await db.update(validationIntents).set({ enqueueState: "unavailable", updatedAt: new Date() })
        .where(eq(validationIntents.id, intentId));
      return false;
    }
    await queue.add("validation-intent", { intentId }, {
      jobId: `validation-intent-${intentId}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
    });
    await db.update(validationIntents).set({ enqueueState: "enqueued", updatedAt: new Date() })
      .where(eq(validationIntents.id, intentId));
    return true;
  } catch {
    await db.update(validationIntents).set({ enqueueState: "unavailable", updatedAt: new Date() })
      .where(eq(validationIntents.id, intentId)).catch(() => {});
    return false;
  }
}

/** Best-effort producer handoff after a committed contact mutation. The durable
 * row remains pending/deferred if queue infrastructure is unavailable. */
export async function enqueueCurrentValidationIntent(contactId: number): Promise<boolean> {
  const [intent] = await db.select({ id: validationIntents.id })
    .from(validationIntents)
    .where(and(
      eq(validationIntents.contactId, contactId),
      eq(validationIntents.state, "pending"),
    ))
    .orderBy(desc(validationIntents.createdAt))
    .limit(1);
  return intent ? enqueueValidationIntent(intent.id) : false;
}

/** Queue-owned recovery: replay committed pending intents after a producer,
 * Redis, or process outage. The intent itself is the durable source of truth. */
export async function recoverValidationIntents(limit = 100): Promise<number> {
  // Credits go to the likeliest-deliverable, likeliest-to-convert addresses
  // first: never dead/bad/disposable domains or known bounces, MX-less (A-only)
  // domains last, provider-sourced (Outscraper/Serper-found) contacts first.
  const rows = await db.execute(sql`
    SELECT vi.id FROM validation_intents vi
      JOIN contacts vc ON vc.id=vi.contact_id
      LEFT JOIN contact_email_prefilter pf
        ON pf.contact_id=vi.contact_id AND pf.email_token_hash=vi.normalized_email_token_hash
     WHERE (vi.state = 'pending' AND vi.next_attempt_at <= NOW()
            -- A worker that died mid-claim leaves the intent 'processing'. processValidationIntent re-checks the
            -- lease, and a dispatched operation still blocks a second purchase (operation key + address claim).
            OR vi.state = 'processing' AND vi.lease_expires_at IS NOT NULL AND vi.lease_expires_at < NOW())
       AND COALESCE(pf.status,'unchecked') NOT IN ('dead_domain','bad_syntax','disposable')
       AND COALESCE(vc.bounce_status,'none')='none' AND vc.bounced_at IS NULL
       AND vc.contact_bounced_at IS NULL AND vc.bounce_date IS NULL
       AND EXISTS (SELECT 1 FROM cr04_enrollment_intents prepared
         JOIN sfp_programs p ON p.id=prepared.program_id
         JOIN contacts c ON c.id=prepared.contact_id AND c.business_id=prepared.business_id
         WHERE prepared.contact_id=vi.contact_id
           AND prepared.normalized_email_hash=vi.normalized_email_token_hash
           AND prepared.preparation_state IN ('pending_validation','ready_held')
           AND p.is_active AND c.archived_at IS NULL)
     ORDER BY COALESCE(pf.status='a_only',FALSE) ASC,
              (CASE WHEN vc.primary_source_type IN ('outscraper','serper','first_party_contact_page','contact_page') THEN 0 ELSE 1 END) ASC,
              vi.created_at
     LIMIT ${limit}
  `);
  let enqueued = 0;
  for (const row of (rows as any).rows ?? []) {
    if (await enqueueValidationIntent(row.id)) enqueued++;
  }
  return enqueued;
}

export type ValidationIntentWorkerDeps = {
  verifyEmail?: (email: string) => Promise<{
    status: string;
    subStatus?: string | null;
    reason?: string;
    outcome?: string;
  }>;
};

async function hasCurrentCro03cValidationAuthority(
  intent: any,
  emailTokenHash?: string | null,
  subjectGeneration?: number,
  checkpoint?: "claim" | "pre_reservation" | "pre_io",
): Promise<boolean> {
  if (intent.purpose !== "cro03_winning_email") return true;
  const result = await db.execute(sql`
    SELECT a.id,
           c.id AS command_id,r.id AS run_id,g.id AS generation_id,
           c.runtime_attestation_id,c.activation_revision
      FROM cro03c_validation_authorizations a
      JOIN validation_intents i ON i.id=a.validation_intent_id
      JOIN contacts contact ON contact.id=a.contact_id
      JOIN cro03c_commands c ON c.id=a.command_id
      JOIN cro03c_runs r ON r.id=a.run_id
      JOIN cro03c_generations g ON g.id=a.generation_id
      JOIN cro03c_runtime_attestations t ON t.id=a.runtime_attestation_id
       JOIN cro03c_activation_policies policy ON policy.id=c.activation_policy_id
      JOIN provider_controls pc ON pc.provider='zerobounce'
     WHERE a.validation_intent_id=${intent.id}::uuid
       AND a.contact_id=${intent.contact_id}
       AND a.subject_generation=${subjectGeneration ?? intent.subject_generation}
       AND (${emailTokenHash ?? intent.normalized_email_token_hash}::text IS NULL
         OR a.normalized_email_hash=${emailTokenHash ?? intent.normalized_email_token_hash})
        AND a.command_id=c.id AND a.run_id=r.id AND a.generation_id=g.id
        AND a.runtime_attestation_id=t.id AND a.activation_revision=c.activation_revision
        AND contact.email_mutation_generation=a.subject_generation
        AND contact.email_token_hash=a.normalized_email_hash
        AND i.normalized_email_token_hash=a.normalized_email_hash
        AND i.subject_generation=a.subject_generation
        AND i.purpose='cro03_winning_email'
       AND (${checkpoint ?? "claim"}='claim'
         OR (${checkpoint ?? "claim"}='pre_reservation' AND pc.version=a.expected_provider_control_revision)
         OR (${checkpoint ?? "claim"}='pre_io' AND pc.version=a.expected_provider_control_revision + 1))
       AND NOT EXISTS (
         SELECT 1 FROM cro03c_validation_revocations rv WHERE rv.authorization_id=a.id
       )
       AND a.authorized_at <= NOW() AND a.expires_at > NOW()
        AND a.unit_cap=1
        AND a.cost_cap_micros=((policy.price_schedules->'zerobounce'->>'amountMicros')::bigint)
         AND (c.caps->>'validationMaxUnits')::int BETWEEN 1 AND 100
         AND (c.caps->>'validationMaxAmountMicros')::bigint =
             (c.caps->>'validationMaxUnits')::bigint *
             ((policy.price_schedules->'zerobounce'->>'amountMicros')::bigint)
         AND (c.caps->>'validationPriceScheduleVersion')::int =
             ((policy.price_schedules->'zerobounce'->>'version')::int)
       AND c.command_type='initial_batch' AND c.state='running'
       AND c.cancel_requested_at IS NULL AND c.expires_at > NOW()
       AND r.state='running' AND g.state='running'
       AND t.expires_at > NOW() AND t.db_healthy=TRUE AND t.redis_healthy=TRUE
       AND t.worker_heartbeat_at > NOW() - INTERVAL '60 seconds'
       AND t.artifact_sha=${process.env.RELEASE_SHA ?? ""}
        AND t.migration_head=${CRO03C_CURRENT_MIGRATION_HEAD}
     LIMIT 1
  `);
  const authority = ((result as any).rows ?? [])[0];
  if (!authority) return false;
  try {
    const { assertCro03cCommandAuthorityBeforeIo } = await import("./cro03/live-execution");
    await assertCro03cCommandAuthorityBeforeIo({
      commandId: String(authority.command_id),
      runId: String(authority.run_id),
      generationId: String(authority.generation_id),
      runtimeAttestationId: String(authority.runtime_attestation_id),
      activationRevision: Number(authority.activation_revision),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute one validation intent under a durable claim. Provider controls are
 * deliberately checked and reserved before transport; a missing/disabled
 * control leaves the intent deferred and never produces positive evidence.
 */
export async function processValidationIntent(
  intentId: string,
  deps: ValidationIntentWorkerDeps = {},
): Promise<"completed" | "deferred" | "superseded" | "failed" | "not_found"> {
  const claimToken = randomUUID();
  const claim = await db.execute(sql`
    UPDATE validation_intents
       SET state = 'processing', claim_token = ${claimToken}::uuid,
           lease_expires_at = NOW() + INTERVAL '5 minutes',
           attempt_count = attempt_count + 1, updated_at = NOW()
     WHERE id = ${intentId}::uuid
       AND state IN ('pending', 'processing')
       AND (state = 'pending' OR lease_expires_at IS NULL OR lease_expires_at < NOW())
     RETURNING *
  `);
  const intent = (claim as any).rows?.[0];
  if (!intent) return "not_found";
  if (!await currentCanonicalValidationSelection(Number(intent.contact_id),String(intent.normalized_email_token_hash))) {
    await db.execute(sql`
      UPDATE validation_intents SET state='blocked',terminal_code='canonical_target_selection_required',
             lease_expires_at=NULL,claim_token=NULL,completed_at=NOW(),updated_at=NOW()
       WHERE id=${intentId}::uuid AND claim_token=${claimToken}::uuid
    `);
    return "failed";
  }

  const contactResult = await db.execute(sql`
    SELECT id, email, email_mutation_generation, business_id
      FROM contacts WHERE id = ${intent.contact_id} LIMIT 1
  `);
  const contact = (contactResult as any).rows?.[0];
  if (!contact) {
    await db.execute(sql`
      UPDATE validation_intents
         SET state = 'failed', terminal_code = 'contact_missing',
             completed_at = NOW(), updated_at = NOW()
       WHERE id = ${intentId}::uuid AND claim_token = ${claimToken}::uuid
    `);
    return "failed";
  }
  // Task #1956 step 6: real ZeroBounce spend must never occur for DBPR-family
  // lineage, on either path. Canonical predicate from server/services/dbpr.ts.
  if (contact.business_id != null) {
    const { businessHasDbprLineageSql } = await import("./dbpr");
    const dbprCheck = await db.execute(sql`SELECT ${businessHasDbprLineageSql(sql`${Number(contact.business_id)}`)} AS has_dbpr`);
    if ((dbprCheck as any).rows?.[0]?.has_dbpr) {
      await db.execute(sql`
        UPDATE validation_intents
           SET state = 'blocked', terminal_code = 'dbpr_lineage_excluded',
               lease_expires_at = NULL, claim_token = NULL, completed_at = NOW(), updated_at = NOW()
         WHERE id = ${intentId}::uuid AND claim_token = ${claimToken}::uuid
      `);
      return "failed";
    }
  }
  // Free prefilter: dead/malformed/disposable domains and known bounces never
  // spend a ZeroBounce credit.
  {
    const { emailPrefilterSpendBlock } = await import("./email-prefilter");
    const blocked = await emailPrefilterSpendBlock(Number(contact.id), String(contact.email));
    if (blocked) {
      await db.execute(sql`
        UPDATE validation_intents
           SET state = 'blocked', terminal_code = ${blocked},
               lease_expires_at = NULL, claim_token = NULL, completed_at = NOW(), updated_at = NOW()
         WHERE id = ${intentId}::uuid AND claim_token = ${claimToken}::uuid
      `);
      return "failed";
    }
  }
  const tokenHash = hashEmailToken(contact.email);
  if (
    tokenHash !== intent.normalized_email_token_hash ||
    Number(contact.email_mutation_generation) !== Number(intent.subject_generation)
  ) {
    await db.execute(sql`
      UPDATE validation_intents
         SET state = 'superseded', terminal_code = 'subject_changed',
             completed_at = NOW(), updated_at = NOW()
       WHERE id = ${intentId}::uuid AND claim_token = ${claimToken}::uuid
    `);
    return "superseded";
  }

  if (!await currentCanonicalValidationSelection(Number(contact.id),tokenHash!)) {
    await db.execute(sql`
      UPDATE validation_intents SET state='blocked',terminal_code='canonical_target_selection_stale',
             lease_expires_at=NULL,claim_token=NULL,completed_at=NOW(),updated_at=NOW()
       WHERE id=${intentId}::uuid AND claim_token=${claimToken}::uuid
    `);
    return "failed";
  }

  const policy = await getActiveSfpOutreachPolicy({bypassCache:true});
  const admission = await db.transaction(async tx => {
    const owner = await claimCanonicalAddressValidation(tokenHash!,tx);
    if (!owner) return {owner:null,receipt:null};
    const receipt = await findFreshProviderObservation({
      businessId:Number(contact.business_id),emailTokenHash:tokenHash!,ttlDays:policy.validationTtlDays,
    },tx);
    if (receipt) await releaseCanonicalAddressValidation(owner,tx);
    return {owner:receipt ? null : owner,receipt};
  });
  if (admission.receipt) {
    const projected = await db.transaction(async tx => {
      if (!await currentCanonicalValidationSelection(Number(contact.id),tokenHash!,tx)) {
        await tx.execute(sql`UPDATE validation_intents SET state='blocked',
          terminal_code='canonical_target_selection_stale',claim_token=NULL,lease_expires_at=NULL
          WHERE id=${intentId}::uuid AND claim_token=${claimToken}::uuid`);
        return false;
      }
      await tx.execute(sql`UPDATE contacts SET
        email_status=${admission.receipt!.outcome === "valid" ? "valid" : "invalid"},
        email_token_hash=${tokenHash},email_validation_updated_at=${admission.receipt!.observedAt}::timestamptz
        WHERE id=${contact.id} AND email_mutation_generation=${intent.subject_generation}
          AND encode(sha256(convert_to(lower(trim(email)),'UTF8')),'hex')=${tokenHash}`);
      await tx.execute(sql`UPDATE validation_intents SET state='completed',operation_id=${admission.receipt!.operationId}::uuid,
        terminal_code=${admission.receipt!.outcome === "valid" ? "fresh_address_receipt_reused" : "fresh_address_rejected"},
        claim_token=NULL,lease_expires_at=NULL,completed_at=NOW(),updated_at=NOW()
        WHERE id=${intentId}::uuid AND claim_token=${claimToken}::uuid`);
      return true;
    });
    return projected ? "completed" : "failed";
  }
  const addressOwner = admission.owner;
  if (!addressOwner) {
    await db.execute(sql`UPDATE validation_intents SET state='pending',enqueue_state='deferred',
      terminal_code='shared_address_validation_in_flight',claim_token=NULL,lease_expires_at=NULL,
      next_attempt_at=NOW()+INTERVAL '5 minutes',updated_at=NOW()
      WHERE id=${intentId}::uuid AND claim_token=${claimToken}::uuid`);
    return "deferred";
  }
  try {
  if (!deps.verifyEmail && !(process.env.ZEROBOUNCE_API_KEY ?? process.env.ZEROBOUNCE_APi_KEY)) {
    await db.execute(sql`UPDATE validation_intents SET state='pending',enqueue_state='deferred',
      terminal_code='provider_not_configured',claim_token=NULL,lease_expires_at=NULL,
      next_attempt_at=NOW()+INTERVAL '5 minutes',updated_at=NOW()
      WHERE id=${intentId}::uuid AND claim_token=${claimToken}::uuid`);
    return "deferred";
  }
  const operationKey = `validation-intent:${intentId}:attempt:${Number(intent.attempt_count)}`;
  const recentAttempts = (await db.execute(sql`SELECT count(*)::int n FROM provider_operations op
    JOIN provider_attempts attempt ON attempt.operation_id=op.id
    WHERE op.provider='zerobounce' AND op.target_fingerprint=${tokenHash}
      AND attempt.dispatch_marked_at>NOW()-INTERVAL '24 hours'`) as any).rows?.[0];
  if (Number(recentAttempts?.n)>=5) {
    await releaseCanonicalAddressValidation(addressOwner);
    await db.execute(sql`UPDATE validation_intents SET state='blocked',terminal_code='bounded_retry_exhausted',
      claim_token=NULL,lease_expires_at=NULL,completed_at=NOW(),updated_at=NOW()
      WHERE id=${intentId}::uuid AND claim_token=${claimToken}::uuid`);
    return "failed";
  }
  // Once provider I/O was authorized for this idempotency key, never replay it
  // blindly. A prior process may have reached the provider but failed before
  // local commit; that is an ambiguous charge/result and requires reconciliation.
  const existingOperation = await db.execute(sql`
    SELECT id FROM provider_operations
     WHERE provider = 'zerobounce' AND idempotency_key = ${operationKey}
     LIMIT 1
  `);
  if ((existingOperation as any).rows?.[0]) {
    await releaseCanonicalAddressValidation(addressOwner);
    await db.execute(sql`
      UPDATE validation_intents
         SET state = 'blocked', terminal_code = 'ambiguous_billing',
             lease_expires_at = NULL, claim_token = NULL, completed_at = NOW(), updated_at = NOW()
       WHERE id = ${intentId}::uuid AND claim_token = ${claimToken}::uuid
    `);
    return "failed";
  }
  // Usage accounting and operation ownership commit together. This reservation
  // records in-flight work and supports idempotent reconciliation; it is not a
  // local credit ceiling.
  const allocation = await db.execute(sql`
    WITH reservation AS (
      UPDATE provider_controls
         SET reserved_units = reserved_units + 1, version = version + 1, updated_at = NOW()
       WHERE provider = 'zerobounce' AND enabled = TRUE AND circuit_state = 'closed'
       RETURNING provider
    )
    INSERT INTO provider_operations
      (provider, operation_type, purpose, idempotency_key, actor_type, actor_id,
       target_fingerprint, state, requested_units, reserved_units, billing_state, started_at)
    SELECT provider, 'email_validation', ${intent.purpose === "cro03_winning_email" ? "cro03_winning_email" : "marketing_outreach"}, ${operationKey},
           'system', 'validation-intent', ${tokenHash}, 'running', 1, 1, 'reserved', NOW()
      FROM reservation
    RETURNING id
  `);
  const operationId = (allocation as any).rows?.[0]?.id;
  if (!operationId) {
    await releaseCanonicalAddressValidation(addressOwner);
    await db.execute(sql`
      UPDATE validation_intents
         SET state = 'pending', enqueue_state = 'deferred',
             terminal_code = 'provider_control_unavailable', lease_expires_at = NULL,
             claim_token = NULL, updated_at = NOW()
       WHERE id = ${intentId}::uuid AND claim_token = ${claimToken}::uuid
    `);
    return "deferred";
  }
  await bindCanonicalAddressOperation(addressOwner,String(operationId));
  const attempt = await db.execute(sql`
    INSERT INTO provider_attempts (operation_id, attempt_number, outcome, started_at)
    VALUES (${operationId}::uuid, 1, 'pending', NOW())
    ON CONFLICT (operation_id, attempt_number) DO UPDATE SET started_at = NOW()
    RETURNING id
  `);
  const attemptId = (attempt as any).rows?.[0]?.id;
  let dispatchFailureReason="canonical_target_selection_stale";
  const dispatchReady = await db.transaction(async tx => {
    if (!deps.verifyEmail) {
      const {lockCurrentSfpRuntimeOwner}=await import("./cro03/sfp-provider-operations");
      const runtime=await lockCurrentSfpRuntimeOwner(tx);
      await tx.execute(sql`UPDATE provider_operations SET
        runtime_owner_epoch=${runtime.ownerEpoch},runtime_owner_token=${runtime.ownerToken}::uuid
        WHERE id=${operationId}::uuid AND state='running'`);
    }
    const selected = await currentCanonicalValidationSelection(Number(contact.id),tokenHash!,tx);
    if (!selected) return false;
    const state = (await tx.execute(sql`SELECT enabled,circuit_state FROM provider_controls
      WHERE provider='zerobounce' FOR SHARE`) as any).rows?.[0];
    if (!state?.enabled || state.circuit_state !== "closed") {
      dispatchFailureReason="provider_control_unavailable";
      return false;
    }
    await markCanonicalAddressDispatch(addressOwner,String(operationId),tx);
    await tx.execute(sql`UPDATE provider_attempts SET dispatch_marked_at=clock_timestamp()
      WHERE id=${attemptId}::uuid AND dispatch_marked_at IS NULL`);
    return true;
  }).catch(()=>{
    dispatchFailureReason="predispatch_authority_unavailable";
    return false;
  });
  if (!dispatchReady) {
    await db.execute(sql`
      UPDATE provider_operations SET state='cancelled',billing_state='released',completed_at=NOW(),updated_at=NOW()
       WHERE id=${operationId}::uuid AND state='running'
    `);
    await db.execute(sql`
      UPDATE provider_controls SET reserved_units=GREATEST(0,reserved_units-1),version=version+1,updated_at=NOW()
       WHERE provider='zerobounce'
    `);
    await db.execute(sql`
      UPDATE validation_intents SET
             state=${dispatchFailureReason==="canonical_target_selection_stale" ? "blocked" : "pending"},
             terminal_code=${dispatchFailureReason},
             lease_expires_at=NULL,claim_token=NULL,
             completed_at=${dispatchFailureReason==="canonical_target_selection_stale" ? sql`NOW()` : sql`NULL`},
             next_attempt_at=NOW()+INTERVAL '5 minutes',updated_at=NOW()
       WHERE id=${intentId}::uuid AND claim_token=${claimToken}::uuid
    `);
    await releaseCanonicalAddressValidation(addressOwner);
    return "failed";
  }
  let result;
  try {
    result = deps.verifyEmail ? await deps.verifyEmail(contact.email)
      : await (await import("./sdr/zerobounce")).verifyEmail(contact.email,{
        dispatch:{addressClaim:addressOwner,operationId:String(operationId)},
      });
  } catch {
    result = { status: "unknown", reason: "transport", outcome: "unavailable" };
  }
  const positive = result.status === "valid" && !result.reason && result.outcome === "completed";
  const providerCompleted = result.outcome === "completed" && !result.reason;
  const negative = providerCompleted && ["invalid","unsafe"].includes(result.status);
  const definitiveResponse = providerCompleted || ["http_4xx","http_5xx"].includes(result.reason ?? "");
  const observationOutcome = positive ? "valid" : negative ? "invalid" : (() => {
    const candidate = result.reason ?? result.status ?? "unknown";
    // Provider vocabulary is intentionally narrower than the durable evidence
    // vocabulary. These are completed, non-positive results, not transport
    // failures: preserve their fail-closed meaning without violating the
    // constrained observation model.
    if (candidate === "unsafe") return "risky";
    if (candidate === "unverified") return "unknown";
    if (["valid", "invalid", "risky", "unknown", "not_configured", "budget_blocked",
      "circuit_blocked", "rate_limited", "rejected", "timeout", "transport", "parse_error",
      "ambiguous_billing", "no_result", "superseded"].includes(candidate)) return candidate;
    if (candidate === "http_4xx" || candidate === "http_5xx") return "rejected";
    return "unknown";
  })();
  await db.execute(sql`
    INSERT INTO provider_observations
      (provider, operation_id, attempt_id, subject_type, subject_id,
       email_token_hash, subject_generation, outcome, retryable, observed_at)
    VALUES ('zerobounce', ${operationId}::uuid, ${attemptId}::uuid, 'contact',
            ${contact.id}, ${tokenHash}, ${intent.subject_generation},
            ${observationOutcome}, ${!positive && !negative}, NOW())
  `);
  await db.execute(sql`
    UPDATE provider_attempts
       SET outcome = ${providerCompleted ? "completed" : "retryable_failed"},
           retryable = ${!providerCompleted}, error_code = ${providerCompleted ? null : (result.reason ?? "non_positive")},
           completed_at = NOW()
     WHERE id = ${attemptId}::uuid
  `);
  await db.execute(sql`
    UPDATE provider_operations
        SET state = ${providerCompleted ? "completed" : "failed"},
            billing_state = ${providerCompleted ? "committed" : "ambiguous"},
            settled_units=${definitiveResponse ? 1 : 0},
            provider_usage_quantity=${definitiveResponse ? "1" : null}::numeric,
            provider_usage_unit=${definitiveResponse ? "request" : null},
            provider_usage_status=${definitiveResponse ? "known" : "unknown"},
           completed_at = NOW(), updated_at = NOW()
     WHERE id = ${operationId}::uuid
  `);
  if (positive || negative) {
    await db.execute(sql`
      UPDATE contacts
         SET email_status = ${positive ? "valid" : "invalid"}, email_token_hash = ${tokenHash},
             email_validation_updated_at = NOW()
       WHERE id = ${contact.id}
         AND email_mutation_generation = ${intent.subject_generation}
         AND encode(sha256(convert_to(lower(trim(email)),'UTF8')),'hex')=${tokenHash}
    `);
  }
  await db.execute(sql`
    UPDATE provider_controls
        SET reserved_units = ${definitiveResponse ? sql`GREATEST(0, reserved_units - 1)` : sql`reserved_units`},
            consumed_units = ${definitiveResponse ? sql`consumed_units + 1` : sql`consumed_units`},
            last_completed_at = ${definitiveResponse ? sql`NOW()` : sql`last_completed_at`},
            last_outcome = ${definitiveResponse ? (positive ? "valid" : "non_positive") : "ambiguous_billing"},
           observed_at = NOW(), version = version + 1, updated_at = NOW()
     WHERE provider = 'zerobounce'
  `);
  await db.execute(sql`
    UPDATE validation_intents
        SET state = ${positive || negative ? "completed" : definitiveResponse ? "pending" : "blocked"},
           enqueue_state=${positive || negative ? "enqueued" : "deferred"},
           next_attempt_at=NOW()+INTERVAL '5 minutes',
           operation_id = ${operationId}::uuid,
            terminal_code = ${positive ? null : (providerCompleted ? (result.reason ?? "non_positive") : "ambiguous_billing")},
           completed_at = NOW(), lease_expires_at = NULL, claim_token = NULL,
           updated_at = NOW()
     WHERE id = ${intentId}::uuid AND claim_token = ${claimToken}::uuid
  `);
  return positive || negative ? "completed" : "deferred";
  } finally {
    // Token-fenced release is safe on every exit; ambiguous dispatched I/O
    // deliberately remains owned for reconciliation.
    await releaseCanonicalAddressValidation(addressOwner);
  }
}

/** Compatibility producers delegate to the same contact/address spend owner. */
export async function delegateSelectedAddressValidation(input: {
  businessId: number; email: string; deps?: ValidationIntentWorkerDeps;
}) {
  const tokenHash=hashEmailToken(input.email);
  if (!tokenHash) return {state:"deferred" as const,receipt:null,dispatched:false};
  const recipient=(await db.execute(sql`SELECT c.id,c.email,c.email_mutation_generation
    FROM cr04_enrollment_intents i JOIN contacts c ON c.id=i.contact_id AND c.business_id=i.business_id
    WHERE i.business_id=${input.businessId} AND i.normalized_email_hash=${tokenHash}
      AND i.preparation_state IN ('pending_validation','ready_held')
    ORDER BY i.created_at,i.id LIMIT 1`) as any).rows?.[0];
  if (!recipient || !await currentCanonicalValidationSelection(Number(recipient.id),tokenHash)) {
    return {state:"deferred" as const,receipt:null,dispatched:false};
  }
  await db.transaction(tx=>createValidationIntent(tx,{
    contactId:Number(recipient.id),email:recipient.email,generation:Number(recipient.email_mutation_generation),
  }));
  const intent=(await db.execute(sql`SELECT id,operation_id FROM validation_intents
    WHERE contact_id=${Number(recipient.id)} AND normalized_email_token_hash=${tokenHash}
      AND subject_generation=${Number(recipient.email_mutation_generation)} AND purpose='marketing_outreach'
    ORDER BY created_at DESC LIMIT 1`) as any).rows?.[0];
  if (!intent) return {state:"deferred" as const,receipt:null,dispatched:false};
  const start=(await db.execute(sql`SELECT count(*)::int n FROM provider_operations op
    JOIN provider_attempts a ON a.operation_id=op.id
    WHERE op.idempotency_key LIKE ${`validation-intent:${intent.id}:attempt:%`}
      AND a.dispatch_marked_at IS NOT NULL`) as any).rows?.[0];
  await processValidationIntent(String(intent.id),input.deps);
  const policy=await getActiveSfpOutreachPolicy({bypassCache:true});
  const receipt=await findFreshProviderObservation({
    businessId:input.businessId,emailTokenHash:tokenHash,ttlDays:policy.validationTtlDays,
  });
  const end=(await db.execute(sql`SELECT count(*)::int n FROM provider_operations op
    JOIN provider_attempts a ON a.operation_id=op.id
    WHERE op.idempotency_key LIKE ${`validation-intent:${intent.id}:attempt:%`}
      AND a.dispatch_marked_at IS NOT NULL`) as any).rows?.[0];
  return {state:receipt ? "completed" as const : "deferred" as const,receipt,
    dispatched:Number(end?.n)>Number(start?.n),intentId:String(intent.id)};
}