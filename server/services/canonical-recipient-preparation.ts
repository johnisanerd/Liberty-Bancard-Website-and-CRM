import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { evaluateContactDecisions } from "./contactability";
import { effectiveBusinessVerticalSql } from "@shared/effective-vertical";
import { contactTargetVerticalSql } from "@shared/contact-vertical-taxonomy";
import { resolveGeographyFromCandidates } from "./cro03/sfp-geography-resolver";
import { relationshipReasonsSql } from "@shared/relationship-evidence-sql";
import { assertSystemLinkDatabaseGuard } from "./commercial-link-authority";
import { findFreshProviderObservation, lockCurrentSfpOutreachPolicy,isCanonicallySuppressed } from "./cro03/sfp-outreach-policy";
import { lockCommercialGraph } from "./commercial-graph-locks";
import { runCanonicalTransaction,boundCanonicalWriteTransaction } from "./canonical-transaction-retry";
import type { Cr04ActorScope } from "./cr04-cohort-ready-authority";

const rows = (result: any): any[] => result?.rows ?? result ?? [];
type PreparationState = "pending_validation" | "ready_held" | "exception" | "rejected" | "suppressed";
export interface CanonicalPreparationInput {
  contactId: number;
  sequenceId: number;
  programId?: string | null;
  actor: Cr04ActorScope;
  source: string;
  historicalCohortRunId?: string | null;
  dealId?: number | null;
  beforeWrite?: (tx: any) => Promise<void>;
  /** Outside the write transaction: renew only a still-live worker claim and
   * checkpoint around potentially slow qualification. Never send authority. */
  checkpoint?: () => Promise<unknown>;
  /** Optional phase stopwatch (milliseconds per phase, accumulated). Diagnostic only; never affects behaviour. */
  timings?: Record<string, number>;
}

export async function assertCanonicalPreparationDatabaseGuard(tx: any) {
  const guard = rows(await tx.execute(sql`SELECT (EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
     WHERE t.tgrelid='public.cr04_enrollment_intents'::regclass
       AND t.tgname='canonical_preparation_capacity' AND t.tgenabled IN ('O','A')
       AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgtype=23
       AND p.pronamespace='public'::regnamespace
       AND p.proname='crm_enforce_canonical_preparation_capacity'
       AND md5(p.prosrc)='6e8864b97bd634386a156bca78c2dc5b'
  ) AND (SELECT count(*)=5 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='cr04_enrollment_intents'
       AND (column_name,data_type) IN (
         ('program_id','uuid'),('business_id','integer'),
         ('normalized_email_hash','text'),('preparation_state','text'),
         ('preparation_snapshot','jsonb')
       ))
    AND EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid=to_regclass('public.cr04_enrollment_intents')
        AND conname='canonical_preparation_scope_chk' AND contype='c'
        AND convalidated AND conislocal AND coninhcount=0)
  ) AS installed`))[0];
  if (guard?.installed !== true) throw new Error("CANONICAL_PREPARATION_NATIVE_CONTRACT_REQUIRED");
}

/** Stable selection preference, not spend authority. Existing useful paused
 * commitments stay first; person/decision-maker addresses precede role mailboxes.
 * The native distinct-address allowance still serializes actual admission. */
function recipientPrioritySql(alias:string) {
  if (!/^[a-z][a-z0-9_]*$/i.test(alias)) throw new Error("CANONICAL_RECIPIENT_SQL_ALIAS_INVALID");
  return sql.raw(`CASE
    WHEN ${alias}.title ~* '(owner|founder|president|chief|ceo|manager|director)' THEN 0
    WHEN split_part(lower(trim(${alias}.email)),'@',1)
      ~ '^(info|contact|office|hello|support|sales|admin|billing|accounts|service)([._+-]|$)' THEN 30
    WHEN NULLIF(trim(${alias}.first_name),'') IS NOT NULL
      AND lower(trim(${alias}.first_name)) IS DISTINCT FROM lower(trim(${alias}.company_name)) THEN 10
    ELSE 20 END`);
}

/**
 * One local preparation owner, backed by the existing enrollment-intent ledger.
 * A current program and explicit current sequence package replace cohort
 * membership. Qualification snapshots and original address receipts are retained;
 * blocked intent status and paused membership NEVER convey send approval.
 */
export async function prepareCanonicalRecipient(input: CanonicalPreparationInput) {
  const first=await prepareCanonicalRecipientPass(input);
  // Qualification reads outside the write transaction. When retained evidence
  // repairs compatibility hygiene, refresh it after commit with all the same
  // authority/binding checks; don't leave a permanently stale readiness snapshot.
  // This is at most one extra local pass, never provider execution or recursion.
  if ("receiptProjectionChanged" in first && first.receiptProjectionChanged) {
    return prepareCanonicalRecipientPass(input);
  }
  return first;
}

async function prepareCanonicalRecipientPass(input: CanonicalPreparationInput) {
  const held = (reasonCode: string) => ({
    replayed: false, blocked: true, reasonCode, enrollmentId: null,
    preparationState: "exception" as PreparationState,
  });
  let mark = Date.now();
  // Certification-only round-trip counter; absent in production, so it costs nothing there.
  const counter = (globalThis as any).__preparationQueryCounter as { n: number } | undefined;
  let markQueries = counter?.n ?? 0;
  const lap = (phase: string) => {
    const now = Date.now();
    if (input.timings) {
      input.timings[phase] = (input.timings[phase] ?? 0) + now - mark;
      if (counter) input.timings[`q_${phase}`] = (input.timings[`q_${phase}`] ?? 0) + counter.n - markQueries;
    }
    mark = now;
    markQueries = counter?.n ?? 0;
  };
  if (!Number.isSafeInteger(input.contactId) || input.contactId < 1 ||
      !Number.isSafeInteger(input.sequenceId) || input.sequenceId < 1) {
    throw new Error("CANONICAL_PREPARATION_IDENTIFIERS_INVALID");
  }
  if (!["admin","manager","agent"].includes(input.actor.role) || !input.actor.actorId) {
    return held("CANONICAL_PREPARATION_ACTOR_REQUIRED");
  }
  // This evaluates channel readiness but does NOT require a cohort or provider
  // request. Pending validation may persist a local preparation and membership.
  const { evaluateCr04ChannelQualification } = await import("./cr04-cohort-ready-authority");
  lap("setup");
  if (input.checkpoint) await input.checkpoint();
  lap("checkpoint");
  const decision = await evaluateCr04ChannelQualification(input.contactId, {
    channel: "email", sequenceId: input.sequenceId, scope: input.actor, persist: true,
    timings: input.timings,
  });
  lap("qualification");
  if (input.checkpoint) await input.checkpoint();
  lap("checkpoint");
  if (!decision.id) return held("CHANNEL_QUALIFICATION_SNAPSHOT_UNAVAILABLE");
  // A read-only candidate peek must not hold the singleton runtime pins.
  // The contact is locked and its affiliation rechecked inside the write unit.
  const peek = rows(await db.execute(sql`SELECT business_id FROM contacts WHERE id=${input.contactId}`))[0];
  if (!peek?.business_id) return held("INDEPENDENT_BUSINESS_AFFILIATION_REQUIRED");

  lap("peek");
  const txStartedAt = Date.now();
  const innerBefore = input.timings ? Object.entries(input.timings).reduce((a, [k, b]) => k.startsWith("q_") ? a : a + b, 0) : 0;
  const committed = await runCanonicalTransaction("preparation_commit", () => db.transaction(async tx => {
    lap("tx_open");
    await boundCanonicalWriteTransaction(tx);
    if (input.beforeWrite) await input.beforeWrite(tx);
    lap("tx_worker_guard");
    await assertSystemLinkDatabaseGuard(tx);
    await assertCanonicalPreparationDatabaseGuard(tx);
    lap("tx_native_guards");
    const policy = await lockCurrentSfpOutreachPolicy(tx);
    lap("tx_policy_lock");
    await lockCommercialGraph(tx, [
      { type: "business", id: Number(peek.business_id) }, { type: "contact", id: input.contactId },
    ], ["contact_business","relationship"]);
    lap("tx_graph_lock");
    const contact = rows(await tx.execute(sql`
      SELECT id,business_id,email,assigned_to,archived_at,email_mutation_generation,email_status
        FROM contacts WHERE id=${input.contactId} FOR UPDATE
    `))[0];
    const sequenceState=rows(await tx.execute(sql`SELECT retired_at FROM follow_up_sequences
      WHERE id=${input.sequenceId} FOR SHARE`))[0];
    if(!sequenceState) return held("SEQUENCE_UNAVAILABLE");
    if(sequenceState.retired_at) return held("SEQUENCE_RETIRED");
    if (!contact || contact.archived_at) return held("CURRENT_CONTACT_REQUIRED");
    if (Number(contact.business_id) !== Number(peek.business_id)) {
      return held("CURRENT_BUSINESS_AFFILIATION_CHANGED");
    }
    if (input.actor.role === "agent" && String(contact.assigned_to ?? "") !== input.actor.actorId) {
      return held("CONTACT_OWNERSHIP_REQUIRED");
    }
    if (!contact.business_id) return held("INDEPENDENT_BUSINESS_AFFILIATION_REQUIRED");
    const business = rows(await tx.execute(sql`
      SELECT b.id,b.city,b.state,b.postal_code,${sql.raw(effectiveBusinessVerticalSql("b"))} AS vertical,
        md5(to_jsonb(b)::text||COALESCE((SELECT jsonb_agg(to_jsonb(bl) ORDER BY bl.id)::text
          FROM business_locations bl WHERE bl.business_id=b.id),'[]')) AS source_fingerprint
        FROM businesses b WHERE b.id=${Number(contact.business_id)} AND b.record_class='canonical'
        AND EXISTS (SELECT 1 FROM contact_business_link_decisions l
          LEFT JOIN contact_business_system_link_evidence proof ON proof.id=l.system_evidence_id
         WHERE l.contact_id=${input.contactId} AND l.business_id=b.id
           AND l.decision='verified' AND l.superseded_at IS NULL
           AND (proof.id IS NULL OR
             ${sql.raw(relationshipReasonsSql(`${input.contactId}`, "b.id", "proof.source_link_id", "proof.source_entity_id"))}
               <@ ARRAY['current_link_decision_exists']::text[]))
        FOR UPDATE OF b
    `))[0];
    if (!business) return held("INDEPENDENT_BUSINESS_AFFILIATION_REQUIRED");
    const locations = rows(await tx.execute(sql`
      SELECT id,is_primary,city,state,postal_code,county_fips FROM business_locations
       WHERE business_id=${Number(business.id)} ORDER BY id FOR SHARE
    `));
    const geography = resolveGeographyFromCandidates([
      ...locations.map(location => ({
        locationId: Number(location.id),isPrimary: location.is_primary === true,
        city: location.city,state: location.state,postalCode: location.postal_code,countyFips: location.county_fips,
      })),
      { locationId: null,isPrimary: false,city: business.city,state: business.state,
        postalCode: business.postal_code,countyFips: null },
    ]);
    if (!geography.eligible || !geography.countyFips) return held("CURRENT_GEOGRAPHY_UNRESOLVED_OR_EXCLUDED");
    const packages = rows(await tx.execute(sql`
      SELECT p.id AS program_id,p.policy_version,package.id AS package_id,
        package.content_hash,package.campaign_id,sequence.trigger_config
        FROM sfp_programs p
        JOIN follow_up_sequences sequence ON sequence.id=${input.sequenceId}
        LEFT JOIN sfp_campaign_package_versions package ON package.sequence_id=sequence.id
          AND package.lifecycle_state='current'
          AND ${sql.raw(contactTargetVerticalSql("package.vertical"))}=${business.vertical}
       WHERE p.is_active=TRUE AND ${geography.countyFips}::text=ANY(p.county_fips)
         AND p.taxonomy_version=2
         AND ${business.vertical}::text=ANY(p.vertical_ids)
         AND (${input.programId ?? null}::uuid IS NULL OR p.id=${input.programId ?? null}::uuid)
         AND (package.id IS NOT NULL OR (
           sequence.trigger_config->>'canonicalProgramId'=p.id::text
           AND sequence.trigger_config->'canonicalVerticals' ? ${business.vertical}
         ))
       AND sequence.retired_at IS NULL
       FOR SHARE OF p,sequence
    `));
    if (packages.length !== 1) {
      return held(packages.length ? "PROGRAM_BINDING_AMBIGUOUS" : "CURRENT_PROGRAM_SEQUENCE_BINDING_REQUIRED");
    }
    const binding = packages[0];
    const email = String(contact.email ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return held("AVAILABLE_EMAIL_REQUIRED");
    const emailHash = createHash("sha256").update(email).digest("hex");
    // Inspect current alternatives without creating intents for every stored
    // email. Duplicate normalized addresses rank once, regardless of contact IDs.
    lap("tx_reads_and_binding");
    const preferred=rows(await tx.execute(sql`SELECT email_hash FROM (
      SELECT DISTINCT ON (lower(trim(c.email)))
        encode(sha256(convert_to(lower(trim(c.email)),'UTF8')),'hex') email_hash,
        EXISTS(SELECT 1 FROM cr04_enrollment_intents current_slot
          WHERE current_slot.business_id=c.business_id
            AND current_slot.program_id=${String(binding.program_id)}::uuid
            AND current_slot.normalized_email_hash=
              encode(sha256(convert_to(lower(trim(c.email)),'UTF8')),'hex')
            AND current_slot.preparation_state IN ('pending_validation','ready_held')) committed,
        ${recipientPrioritySql("c")} priority,c.id
      FROM contacts c WHERE c.business_id=${Number(business.id)} AND c.record_class='production'
        AND c.archived_at IS NULL AND c.do_not_contact IS NOT TRUE
        AND c.do_not_auto_contact IS NOT TRUE AND c.opted_out_email IS NOT TRUE
        AND COALESCE(c.email_status,'') NOT IN ('invalid','bounced','unsafe','opted_out')
        AND c.email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
        AND lower(trim(c.email)) !~ '^(no-?reply|do-?not-?reply)@'
        AND EXISTS(SELECT 1 FROM contact_business_link_decisions independent
          WHERE independent.contact_id=c.id AND independent.business_id=c.business_id
            AND independent.decision='verified' AND independent.superseded_at IS NULL)
      ORDER BY lower(trim(c.email)),${recipientPrioritySql("c")},c.id
    ) distinct_addresses ORDER BY committed DESC,priority,id LIMIT 3`));
    lap("tx_preferred_recipients");
    const priorPreparation=rows(await tx.execute(sql`SELECT id FROM cr04_enrollment_intents
      WHERE business_id=${Number(business.id)} AND program_id=${String(binding.program_id)}::uuid
        AND normalized_email_hash=${emailHash} AND sequence_id=${input.sequenceId}`))[0];
    if (!priorPreparation && !preferred.some(candidate=>candidate.email_hash===emailHash)) {
      return held("NOT_SELECTED_MORE_USEFUL_RECIPIENTS_OR_HYGIENE_HOLD");
    }
    // Imported legacy mailboxes have a zero/uninitialized generation. Bootstrap
    // its identity under the contact lock; do not pretend the address changed or
    // rewrite any original provider observation.
    if (Number(contact.email_mutation_generation) === 0) {
      await tx.execute(sql`UPDATE contacts SET email_mutation_generation=1,email_token_hash=${emailHash}
        WHERE id=${input.contactId} AND email_mutation_generation=0`);
      contact.email_mutation_generation=1;
    }
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
      ${`canonical-preparation:${business.id}:${binding.program_id}`},0))`);
    lap("tx_prior_and_lock");
    const receipt = await findFreshProviderObservation({
      businessId: Number(business.id), emailTokenHash: emailHash, ttlDays: policy.validationTtlDays,
    }, tx);
    const eligibility = await evaluateContactDecisions({
      contactId: input.contactId, businessId: Number(business.id),
    }, tx);
    lap("tx_receipt_and_decisions");
    const suppressedAddress=await isCanonicallySuppressed([emailHash],tx,[email]);
    lap("tx_suppression");
    let preparationState: PreparationState = eligibility.promotion.status !== "eligible"
      ? "suppressed" : receipt?.outcome === "invalid" ? "rejected"
        : suppressedAddress ? "suppressed"
          : !receipt ? "pending_validation" : "ready_held";
    let reasonCode: string = preparationState === "suppressed"
      ? eligibility.promotion.reasonCodes[0] ?? "CANONICAL_ADDRESS_SUPPRESSED"
      : preparationState === "rejected" ? "FRESH_ADDRESS_REJECTED"
        : preparationState === "pending_validation" ? "SELECTED_ADDRESS_VALIDATION_PENDING"
          : preparationState === "ready_held" ? "READY_HELD_OUTBOUND_NOT_AUTHORIZED"
            : decision.reasonCodes[0] ?? "CHANNEL_QUALIFICATION_HELD";
    const existing = rows(await tx.execute(sql`
      SELECT id,contact_id,enrollment_id,preparation_snapshot FROM cr04_enrollment_intents
       WHERE program_id=${String(binding.program_id)}::uuid AND business_id=${Number(business.id)}
         AND normalized_email_hash=${emailHash} AND sequence_id=${input.sequenceId}
       FOR UPDATE
    `))[0];
    if (existing && Number(existing.contact_id) !== input.contactId) {
      return held("ADDRESS_ALREADY_PREPARED_WITH_ANOTHER_CONTACT");
    }
    // Changed addresses must not retain a useful slot or dispatchable membership
    // for the superseded address. Only this owner's paused membership is retired.
    await tx.execute(sql`UPDATE sequence_enrollments se SET status='cancelled',updated_at=NOW()
      FROM cr04_enrollment_intents old
      WHERE old.contact_id=${input.contactId} AND old.program_id=${String(binding.program_id)}::uuid
        AND old.normalized_email_hash<>${emailHash} AND se.id=old.enrollment_id
        AND se.status IN ('paused','active') AND se.metadata->>'canonicalPreparationId'=old.id::text`);
    await tx.execute(sql`UPDATE cr04_enrollment_intents SET preparation_state='exception',
      reason_code='CURRENT_ADDRESS_CHANGED',enrollment_id=NULL
      WHERE contact_id=${input.contactId} AND program_id=${String(binding.program_id)}::uuid
        AND normalized_email_hash<>${emailHash}
        AND preparation_state IN ('pending_validation','ready_held')`);
    // A recipient whose journey already started (completed, stopped by a reply/opt-out, or retired after
    // sends) must never be re-prepared into a fresh paused membership: that would restart touch 1.
    if (preparationState === "pending_validation" || preparationState === "ready_held") {
      const startedBefore = rows(await tx.execute(sql`SELECT se.id FROM sequence_enrollments se
        WHERE se.contact_id=${input.contactId} AND se.sequence_id=${input.sequenceId}
          AND se.status NOT IN ('active','paused')
          AND (se.current_step>0 OR EXISTS (SELECT 1 FROM outbound_send_log l WHERE l.sequence_enrollment_id=se.id))
        LIMIT 1`))[0];
      if (startedBefore) {
        preparationState = "exception";
        reasonCode = "JOURNEY_ALREADY_STARTED_FOR_THIS_RECIPIENT";
      }
    }
    const intentId = existing?.id ?? randomUUID();
    const snapshot = {
      programId: String(binding.program_id), policyVersion: binding.policy_version,
      packageVersionId: binding.package_id, contentHash: binding.content_hash,
      explicitSequenceBinding: binding.trigger_config,
      sequenceId: input.sequenceId, businessId: Number(business.id), contactId: input.contactId,
      canonicalVertical: business.vertical, geography,
      businessSourceFingerprint: business.source_fingerprint,
      emailMutationGeneration: contact.email_mutation_generation,
      channelDecisionId: decision.id, validationOperationId: receipt?.operationId ?? null,
      channelQualificationReasons:decision.reasonCodes,channelQualified:decision.qualified,
      originalObservedAt: receipt?.observedAt ?? null, originalExpiresAt: receipt?.expiresAt ?? null,
      validationPolicyDocumentId: policy.id, validationPolicyHash: policy.documentHash,
      historicalCohortRunId: input.historicalCohortRunId ?? null,
      source: input.source, outboundAuthorized: false,
    };
    lap("tx_snapshot_build");
    await tx.execute(sql`
      INSERT INTO cr04_enrollment_intents
        (id,idempotency_key,contact_id,sequence_id,channel,source,actor_id,decision_id,
         status,reason_code,program_id,business_id,normalized_email_hash,preparation_state,preparation_snapshot)
      VALUES (${intentId}::uuid,${`canonical-preparation:${business.id}:${binding.program_id}:${input.sequenceId}:${emailHash}`},
        ${input.contactId},${input.sequenceId},'email',${input.source},${input.actor.actorId},
        ${decision.id}::uuid,'blocked',${reasonCode},${String(binding.program_id)}::uuid,
        ${Number(business.id)},${emailHash},${preparationState},${JSON.stringify(snapshot)}::jsonb)
      ON CONFLICT(id) DO UPDATE SET decision_id=EXCLUDED.decision_id,reason_code=EXCLUDED.reason_code,
        preparation_state=EXCLUDED.preparation_state,preparation_snapshot=EXCLUDED.preparation_snapshot
    `);
    lap("tx_intent_upsert");
    let enrollmentId: number | null = existing?.enrollment_id == null ? null : Number(existing.enrollment_id);
    if (preparationState === "pending_validation" || preparationState === "ready_held") {
      const member = rows(await tx.execute(sql`
        INSERT INTO sequence_enrollments
          (contact_id,sequence_id,deal_id,status,current_step,next_action_at,paused_at,metadata)
        VALUES (${input.contactId},${input.sequenceId},${input.dealId ?? null},'paused',0,NULL,NOW(),
          ${JSON.stringify({ canonicalPreparationId: intentId, programId: binding.program_id,
            preparationState, outboundAuthorized: false })}::jsonb)
        ON CONFLICT(contact_id,sequence_id) WHERE status IN ('active','paused') DO NOTHING RETURNING id,status
      `))[0] ?? rows(await tx.execute(sql`
        SELECT id,status,metadata FROM sequence_enrollments WHERE contact_id=${input.contactId}
          AND sequence_id=${input.sequenceId} AND status IN ('active','paused') FOR UPDATE
      `))[0];
      const ownedJourney = !!member && member.status === "active"
        && member.metadata?.canonicalPreparationId === String(intentId) && !!member.metadata?.canonicalRelease;
      if (ownedJourney) {
        // A released journey in progress is valid work, not an exception. Re-evaluation preserves its step,
        // ownership and send receipts; only genuine changes to approved content or validation hold it.
        enrollmentId = Number(member.id);
        const approvedHash = member.metadata.canonicalRelease?.binding?.contentHash ?? null;
        const holdReason = preparationState === "pending_validation" ? "validation_not_current"
          : approvedHash && binding.content_hash && approvedHash !== binding.content_hash ? "package_content_changed" : null;
        if (holdReason) {
          await tx.execute(sql`UPDATE sequence_enrollments SET status='paused',next_action_at=NULL,updated_at=NOW(),
            metadata=metadata||jsonb_build_object('outboundAuthorized',false,'canonicalRelease',
              (metadata->'canonicalRelease')||jsonb_build_object('endedReason',${holdReason}::text,'endedAt',NOW()::text))
            WHERE id=${enrollmentId} AND status='active'
              AND metadata->>'canonicalPreparationId'=${String(intentId)}`);
        }
      } else if (!member || member.status !== "paused" || member.metadata?.canonicalPreparationId
          && member.metadata.canonicalPreparationId!==String(intentId)) {
        preparationState = "exception";
        reasonCode = "EXISTING_ACTIVE_MEMBERSHIP_NOT_CANONICAL_READY_HELD";
        await tx.execute(sql`UPDATE cr04_enrollment_intents SET preparation_state='exception',
          reason_code='EXISTING_ACTIVE_MEMBERSHIP_NOT_CANONICAL_READY_HELD' WHERE id=${intentId}::uuid`);
      } else {
        enrollmentId = Number(member.id);
        await tx.execute(sql`UPDATE sequence_enrollments SET metadata=metadata||
          ${JSON.stringify({canonicalPreparationId:intentId,programId:binding.program_id})}::jsonb
          WHERE id=${enrollmentId} AND status='paused'
            AND (metadata->>'canonicalPreparationId' IS NULL OR metadata->>'canonicalPreparationId'=${String(intentId)})`);
      }
    } else if (enrollmentId) {
      await tx.execute(sql`UPDATE sequence_enrollments SET status='cancelled',updated_at=NOW(),
          metadata=metadata||jsonb_build_object('retiredReason',${reasonCode}::text)
        WHERE id=${enrollmentId} AND status IN ('paused','active')
          AND metadata->>'canonicalPreparationId'=${String(intentId)}`);
      enrollmentId = null;
    }
    await tx.execute(sql`UPDATE cr04_enrollment_intents SET enrollment_id=${enrollmentId}
      WHERE id=${intentId}::uuid`);
    if (enrollmentId) await tx.execute(sql`UPDATE sequence_enrollments SET metadata=metadata||
      ${JSON.stringify({preparationState,outboundAuthorized:false})}::jsonb
      WHERE id=${enrollmentId} AND status='paused'
        AND metadata->>'canonicalPreparationId'=${String(intentId)}`);
    lap("tx_enrollment_write");
    let receiptProjectionChanged=false;
    if (enrollmentId && preparationState==="ready_held" && receipt?.outcome==="valid") {
      // Reusing a business/address receipt does not create a validation intent.
      // Project that original receipt locally for this genuinely selected,
      // generation-pinned recipient, rather than leaving compatibility hygiene
      // permanently unvalidated. Never mint/extend provider evidence or spend.
      if (await currentCanonicalValidationSelection(input.contactId,emailHash,tx)) {
        await tx.execute(sql`UPDATE contacts SET email_status='valid',
          email_token_hash=${emailHash},email_validation_updated_at=${receipt.observedAt}::timestamptz
          WHERE id=${input.contactId} AND email_mutation_generation=${Number(contact.email_mutation_generation)}
            AND encode(sha256(convert_to(lower(trim(email)),'UTF8')),'hex')=${emailHash}`);
        receiptProjectionChanged=contact.email_status!=="valid";
      }
    }
    lap("tx_receipt_projection");
    if (preparationState === "pending_validation" && enrollmentId) {
      const { createValidationIntent } = await import("./provider-readiness-control");
      await createValidationIntent(tx,{
        contactId:input.contactId,email,generation:Number(contact.email_mutation_generation),
      });
    }
    lap("tx_writes");
    // Revalidate AFTER qualification/locks/writes. A transaction that outlives
    // its cursor or deployment lease rolls back all intent/member mutations.
    if (input.beforeWrite) await input.beforeWrite(tx);
    lap("tx_final_guard");
    return { replayed: Boolean(existing), blocked: enrollmentId === null, intentId: String(intentId), enrollmentId,
      preparationState, reasonCode, decision, outboundAuthorized: false,receiptProjectionChanged };
  }));
  if (input.timings) {
    // Whatever the transaction spent beyond its measured phases (BEGIN/COMMIT, deferred constraint and trigger work).
    const innerAfter = Object.entries(input.timings).reduce((a, [k, b]) => k.startsWith("q_") ? a : a + b, 0);
    input.timings.tx_commit_and_unmeasured = (input.timings.tx_commit_and_unmeasured ?? 0)
      + Math.max(0, Date.now() - txStartedAt - (innerAfter - innerBefore));
  }
  return committed;
}

/**
 * The one definition of "the prepared recipient's recorded facts are still current". Aliases: i = intent,
 * c = contact, b = business, p = program, seq = sequence. Used by validation selection, the launch
 * inventory and the release/dispatch recheck so none of them can drift from the preparation writer.
 * It includes the package pin: a changed package content hash makes the preparation stale.
 */
export function preparedFactsCurrentSql(): string {
  return `p.is_active AND p.taxonomy_version=2
       AND i.preparation_snapshot->>'policyVersion'=p.policy_version::text
       AND i.preparation_snapshot->>'emailMutationGeneration'=c.email_mutation_generation::text
       AND i.preparation_snapshot->>'canonicalVertical'=${effectiveBusinessVerticalSql("b")}
       AND i.preparation_snapshot->>'canonicalVertical'=ANY(p.vertical_ids)
       AND i.preparation_snapshot->'geography'->>'countyFips'=ANY(p.county_fips)
       AND i.preparation_snapshot->>'businessSourceFingerprint'=
         md5(to_jsonb(b)::text||COALESCE((SELECT jsonb_agg(to_jsonb(bl) ORDER BY bl.id)::text
           FROM business_locations bl WHERE bl.business_id=b.id),'[]'))
       AND EXISTS (SELECT 1 FROM contact_business_link_decisions l
         LEFT JOIN contact_business_system_link_evidence proof ON proof.id=l.system_evidence_id
         WHERE l.contact_id=c.id AND l.business_id=b.id AND l.decision='verified'
           AND l.superseded_at IS NULL AND (proof.id IS NULL OR
             ${relationshipReasonsSql("c.id","b.id","proof.source_link_id","proof.source_entity_id")}
               <@ ARRAY['current_link_decision_exists']::text[]))
       AND (i.preparation_snapshot->>'packageVersionId' IS NOT NULL AND EXISTS (
         SELECT 1 FROM sfp_campaign_package_versions pkg
          WHERE pkg.id=(i.preparation_snapshot->>'packageVersionId')::uuid
            AND pkg.sequence_id=seq.id AND pkg.lifecycle_state='current'
            AND pkg.content_hash=i.preparation_snapshot->>'contentHash'
       ) OR NOT EXISTS (SELECT 1 FROM sfp_campaign_package_versions cur
             WHERE cur.sequence_id=seq.id AND cur.lifecycle_state='current')
         AND i.preparation_snapshot->'explicitSequenceBinding'=seq.trigger_config
         AND seq.trigger_config->>'canonicalProgramId'=p.id::text
         AND seq.trigger_config->'canonicalVerticals' ? (i.preparation_snapshot->>'canonicalVertical'))`;
}

/** Only current, actually prepared recipients can enter paid hygiene work. */
export async function currentCanonicalValidationSelection(
  contactId: number, emailTokenHash: string, tx: any = db,
  options: { allowReleasedMembership?: boolean } = {},
) {
  await assertCanonicalPreparationDatabaseGuard(tx);
  if (tx!==db) {
    const peek=rows(await tx.execute(sql`SELECT business_id FROM contacts WHERE id=${contactId}`))[0];
    if (!peek?.business_id) return null;
    await lockCommercialGraph(tx,[
      {type:"business",id:Number(peek.business_id)},{type:"contact",id:contactId},
    ],["contact_business","relationship"]);
    await tx.execute(sql`SELECT id FROM contacts WHERE id=${contactId} FOR UPDATE`);
    await tx.execute(sql`SELECT id FROM businesses WHERE id=${Number(peek.business_id)} FOR UPDATE`);
    await tx.execute(sql`SELECT id FROM business_locations
      WHERE business_id=${Number(peek.business_id)} ORDER BY id FOR SHARE`);
  }
  const selected = rows(await tx.execute(sql`
    SELECT i.id,i.business_id,i.program_id,i.preparation_snapshot
      FROM cr04_enrollment_intents i JOIN contacts c ON c.id=i.contact_id
      JOIN businesses b ON b.id=i.business_id AND b.id=c.business_id
      JOIN sfp_programs p ON p.id=i.program_id
      JOIN follow_up_sequences seq ON seq.id=i.sequence_id AND seq.retired_at IS NULL
      JOIN sequence_enrollments se ON se.id=i.enrollment_id AND se.contact_id=c.id
       AND se.sequence_id=i.sequence_id
       AND se.status IN (${sql.raw(options.allowReleasedMembership ? "'paused','active'" : "'paused'")})
        AND se.metadata->>'canonicalPreparationId'=i.id::text
     WHERE c.id=${contactId} AND i.normalized_email_hash=${emailTokenHash}
       AND encode(sha256(convert_to(lower(trim(c.email)),'UTF8')),'hex')=${emailTokenHash}
       AND c.archived_at IS NULL AND b.record_class='canonical'
       AND i.preparation_state IN ('pending_validation','ready_held')
       AND ${sql.raw(preparedFactsCurrentSql())}
      ORDER BY i.created_at,i.id LIMIT 1 ${tx!==db ? sql`FOR SHARE OF i,p,seq,se` : sql``}
  `))[0];
  if (!selected) return null;
  const decision = await evaluateContactDecisions({contactId,businessId:Number(selected.business_id)},tx);
  if (decision.dataHygiene.status !== "eligible" || decision.promotion.status !== "eligible") return null;
  const [contact]=rows(await tx.execute(sql`SELECT email FROM contacts WHERE id=${contactId}`));
  return !await isCanonicallySuppressed([emailTokenHash],tx,[String(contact?.email ?? "")]) ? selected : null;
}