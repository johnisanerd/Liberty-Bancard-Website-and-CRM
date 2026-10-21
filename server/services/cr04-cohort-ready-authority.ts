/**
 * CR-04 — the only authority for promotional Ready projections, frozen cohorts,
 * and enrollment intents. Lower-layer authorities remain authoritative; this
 * service composes their decisions and never writes their source state.
 */
import { createHash, randomUUID } from "crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db, pool } from "../db";
import {
  contacts,
  campaigns,
  campaignSteps,
  cr04ChannelDecisions,
  cr04CohortDefinitions,
  cr04CohortMembers,
  cr04CohortRuns,
  cr04EnrollmentIntents,
  followUpSequences,
  sequenceEnrollments,
  sequenceSteps,
} from "@shared/schema";
import { READINESS_MODEL_VERSION } from "./contact-readiness";
import { evaluateContactability } from "./contactability";
import { evaluateMarketingEmailEligibility, EMAIL_VALIDATION_POLICY_VERSION } from "./provider-readiness-control";
import { authorizeCommercialUse, CRO02_POLICY_VERSION } from "./commercial-resolution";
import { canEnrollContactInSequence } from "./sequence-eligibility";
import { resolveSender } from "./sender-policy";

export const CR04_POLICY_VERSION = 1;
export const CR04_REASON_TAXONOMY_VERSION = "cr04-reasons-v1";
export const CR04_DECISION_TTL_MS = 15 * 60 * 1000;
export const CR04_COHORT_TTL_MS = 24 * 60 * 60 * 1000;
// A freeze request is deliberately a small unit of work.  Runs retain their
// cursor in membership_fingerprint while they are being built/reconciled; this
// avoids turning an admin HTTP request into an unbounded scan.
export const CR04_COHORT_BATCH_SIZE = 100;

export type Cr04Channel = "email" | "manual_call" | "sms";
export type Cr04DecisionValue = "qualified" | "blocked" | "unavailable";
export type Cr04ReasonCode =
  | "QUALIFIED"
  | "CONTACT_NOT_FOUND"
  | "ARCHIVED"
  | "DO_NOT_CONTACT"
  | "QUEUE_SKIPPED"
  | "ACTIVE_ENROLLMENT"
  | "OWNER_REQUIRED"
  | "OUT_OF_SCOPE"
  | "COMPLETENESS_MISSING"
  | "COMPLETENESS_STALE"
  | "COMPLETENESS_BELOW_POLICY"
  | "ICP_EVIDENCE_MISSING"
  | "OFFER_EVIDENCE_MISSING"
  | "SOURCE_EVIDENCE_MISSING"
  | "COMMERCIAL_AUTHORITY_BLOCKED"
  | "COMMERCIAL_AUTHORITY_UNAVAILABLE"
  | "SEQUENCE_REQUIRED"
  | "SEQUENCE_INACTIVE"
  | "SEQUENCE_INCOMPATIBLE"
  | "CHANNEL_NOT_IN_SEQUENCE"
  | "EMAIL_MISSING"
  | "EMAIL_EVIDENCE_NOT_CURRENT"
  | "PHONE_MISSING"
  | "CONTACTABILITY_BLOCKED"
  | "DEPENDENCY_UNAVAILABLE"
  // Task #1956 Step 8 — data-hygiene dimension reason codes (must match the
  // literal reasonCodes emitted by evaluateContactDecisions().dataHygiene).
  | "DBPR_LINEAGE"
  | "NO_IDENTIFIER";

export interface Cr04ActorScope {
  role: "admin" | "manager" | "agent";
  actorId: string;
  email: string | null;
}

export interface Cr04QualificationContext {
  channel: Cr04Channel;
  sequenceId?: number | null;
  campaignId?: number | null;
  contentVersion?: string | null;
  senderVersion?: string | null;
  replyRouteVersion?: string | null;
  asOf?: Date;
  persist?: boolean;
  scope?: Cr04ActorScope;
  /** Optional phase stopwatch (milliseconds per phase, accumulated; keys start with `qual_`). Diagnostic only. */
  timings?: Record<string, number>;
}

export interface Cr04ChannelDecision {
  id: string | null;
  contactId: number;
  channel: Cr04Channel;
  purpose: "marketing_outreach";
  policyVersion: number;
  taxonomyVersion: string;
  decision: Cr04DecisionValue;
  qualified: boolean;
  reasonCodes: Cr04ReasonCode[];
  dependencyFingerprint: string;
  authorityFingerprint: string;
  decidedAt: string;
  expiresAt: string;
  sequenceId: number | null;
  commercialResolutionSnapshotId: string | null;
}

export interface Cr04ReadyFilters {
  score?: "hot" | "warm" | "cold";
  vertical?: string;
  city?: string;
  assignedTo?: string;
  channel?: Cr04Channel;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function channelForStep(actionType: string | null): Cr04Channel | null {
  if (actionType === "email") return "email";
  if (actionType === "sms") return "sms";
  if (actionType === "task") return "manual_call";
  return null;
}

async function resolveSequence(contactId: number, requestedId: number | null | undefined, channel: Cr04Channel) {
  const candidates = requestedId
    ? await db.select().from(followUpSequences).where(eq(followUpSequences.id, requestedId)).limit(1)
    : await db.select().from(followUpSequences)
        .where(eq(followUpSequences.status, "active"))
        .orderBy(asc(followUpSequences.id));
  for (const sequence of candidates) {
    if (sequence.status !== "active") continue;
    const steps = await db.select({ actionType: sequenceSteps.actionType })
      .from(sequenceSteps).where(eq(sequenceSteps.sequenceId, sequence.id));
    if (!steps.some((step) => channelForStep(step.actionType) === channel)) continue;
    const eligibility = await canEnrollContactInSequence(contactId, sequence);
    if (eligibility.allowed) return { sequence, steps, eligibility };
  }
  return null;
}

function scopeAllows(contact: { assignedTo: string | null }, scope?: Cr04ActorScope): boolean {
  if (!scope) return true;
  if (scope.role === "admin") return true;
  return !!scope.email && contact.assignedTo === scope.email;
}

function normalizeContactabilityReason(reason: string): Cr04ReasonCode {
  return reason ? "CONTACTABILITY_BLOCKED" : "DEPENDENCY_UNAVAILABLE";
}

export async function evaluateCr04ChannelQualification(
  contactId: number,
  context: Cr04QualificationContext,
): Promise<Cr04ChannelDecision> {
  const decidedAt = context.asOf ?? new Date();
  const expiresAt = new Date(decidedAt.getTime() + CR04_DECISION_TTL_MS);
  let decision: Cr04DecisionValue = "blocked";
  const reasons: Cr04ReasonCode[] = [];
  let commercialResolutionSnapshotId: string | null = null;
  let sequenceId: number | null = context.sequenceId ?? null;
  let evidenceRefs: Array<{ authority: string; ref: string; version?: number }> = [];
  let lapAt = Date.now();
  const lap = (phase: string) => {
    const now = Date.now();
    if (context.timings) context.timings[`qual_${phase}`] = (context.timings[`qual_${phase}`] ?? 0) + now - lapAt;
    lapAt = now;
  };

  const [contact] = await db.select({
    id: contacts.id,
    archivedAt: contacts.archivedAt,
    doNotContact: contacts.doNotContact,
    outreachQueueSkippedAt: contacts.outreachQueueSkippedAt,
    assignedTo: contacts.assignedTo,
    email: contacts.email,
    phone: contacts.phone,
    emailMutationGeneration: contacts.emailMutationGeneration,
    smsStatus: contacts.smsStatus,
    consentTier: contacts.consentTier,
    lifecycleStage: contacts.lifecycleStage,
    leadSource: contacts.leadSource,
    sourceCategory: contacts.sourceCategory,
    companyName: contacts.companyName,
    vertical: contacts.vertical,
    primaryOfferPath: contacts.primaryOfferPath,
    dataReadinessScore: contacts.dataReadinessScore,
    readinessModelVersion: contacts.readinessModelVersion,
    readinessUpdatedAt: contacts.readinessUpdatedAt,
    lastMeaningfulContactMutationAt: contacts.lastMeaningfulContactMutationAt,
    updatedAt: contacts.updatedAt,
  }).from(contacts).where(eq(contacts.id, contactId)).limit(1);
  lap("contact_read");

  if (!contact) reasons.push("CONTACT_NOT_FOUND");
  if (contact && !scopeAllows(contact, context.scope)) reasons.push("OUT_OF_SCOPE");
  if (contact?.archivedAt) reasons.push("ARCHIVED");
  if (contact?.doNotContact) reasons.push("DO_NOT_CONTACT");
  if (contact?.outreachQueueSkippedAt) reasons.push("QUEUE_SKIPPED");
  if (contact && !contact.assignedTo) reasons.push("OWNER_REQUIRED");

  if (contact) {
    const [active] = await db.select({ id: sequenceEnrollments.id }).from(sequenceEnrollments)
      .where(and(
        eq(sequenceEnrollments.contactId, contact.id),
        sql`${sequenceEnrollments.status} IN ('active','paused')`,
      )).limit(1);
    if (active) reasons.push("ACTIVE_ENROLLMENT");
    lap("enrollment_check");

    if (contact.dataReadinessScore == null || contact.readinessModelVersion == null) {
      reasons.push("COMPLETENESS_MISSING");
    } else if (
      contact.readinessModelVersion < READINESS_MODEL_VERSION ||
      (contact.lastMeaningfulContactMutationAt && (!contact.readinessUpdatedAt ||
        contact.readinessUpdatedAt < contact.lastMeaningfulContactMutationAt))
    ) {
      reasons.push("COMPLETENESS_STALE");
    } else if (contact.dataReadinessScore < 60) {
      reasons.push("COMPLETENESS_BELOW_POLICY");
    }
    if (!contact.companyName?.trim() || !contact.vertical?.trim()) reasons.push("ICP_EVIDENCE_MISSING");
    if (!contact.primaryOfferPath?.trim()) reasons.push("OFFER_EVIDENCE_MISSING");

    const sourceEvidence = await db.execute(sql`
      SELECT s.id::text AS subject_id, o.id::text AS observation_id
        FROM cro03_source_subjects s
        JOIN cro03_source_observations o ON o.source_subject_id=s.id
       WHERE s.subject_type='contact' AND s.subject_key=${String(contact.id)}
       ORDER BY o.observed_at DESC LIMIT 1
    `).catch(() => ({ rows: [] as any[] }));
    lap("source_evidence");
    const sourceRow = (sourceEvidence as any).rows?.[0];
    if (sourceRow) {
      evidenceRefs.push({ authority: "cro03_source_observation", ref: sourceRow.observation_id });
    } else if (contact.sourceCategory || contact.leadSource) {
      evidenceRefs.push({ authority: "canonical_contact_source", ref: "contact-source-projection-v1", version: 1 });
    } else {
      reasons.push("SOURCE_EVIDENCE_MISSING");
    }

    try {
      const commercial = await authorizeCommercialUse({
        subjectType: "contact",
        subjectId: contact.id,
        effect: "marketing_outreach",
      });
      commercialResolutionSnapshotId = commercial.shadowDecision.snapshotId ?? null;
      if (!commercial.effectiveDecision.allowed) reasons.push("COMMERCIAL_AUTHORITY_BLOCKED");
      if (commercialResolutionSnapshotId) {
        evidenceRefs.push({ authority: "cro02_commercial_resolution", ref: commercialResolutionSnapshotId, version: CRO02_POLICY_VERSION });
      }
    } catch {
      reasons.push("COMMERCIAL_AUTHORITY_UNAVAILABLE");
      decision = "unavailable";
    }

    lap("commercial_authority");
    if (context.campaignId) {
      const [campaign] = await db.select({ id: campaigns.id, status: campaigns.status })
        .from(campaigns).where(eq(campaigns.id, context.campaignId)).limit(1);
      const content = await db.select({
        id: campaignSteps.id,
        subject: campaignSteps.subject,
        bodyTemplate: campaignSteps.bodyTemplate,
      }).from(campaignSteps).where(eq(campaignSteps.campaignId, context.campaignId));
      const sender = resolveSender("cold_outreach");
      const contentReady = content.length > 0 &&
        content.every((step) => !!step.bodyTemplate?.trim() && !!step.subject?.trim());
      const senderReady = !!sender.from && !!sender.replyTo && sender.from === sender.replyTo;
      if (!campaign || campaign.status !== "active" || !contentReady || !senderReady ||
          !context.contentVersion || !context.senderVersion || !context.replyRouteVersion) {
        reasons.push("DEPENDENCY_UNAVAILABLE");
      } else {
        evidenceRefs.push({ authority: "campaign", ref: String(context.campaignId), version: 1 });
        evidenceRefs.push({ authority: "sender_policy", ref: fingerprint(sender), version: 1 });
        evidenceRefs.push({ authority: "campaign_content", ref: fingerprint(content), version: 1 });
      }
    } else {
      const resolved = await resolveSequence(contact.id, context.sequenceId, context.channel);
      if (!resolved) {
        reasons.push(context.sequenceId ? "SEQUENCE_INCOMPATIBLE" : "SEQUENCE_REQUIRED");
      } else {
        sequenceId = resolved.sequence.id;
        evidenceRefs.push({ authority: "sequence", ref: String(resolved.sequence.id), version: 1 });
        const offerRoutes = resolved.sequence.offerRoutes ?? [];
        if (offerRoutes.length > 0 && (!contact.primaryOfferPath || !offerRoutes.includes(contact.primaryOfferPath))) {
          reasons.push("SEQUENCE_INCOMPATIBLE");
        }
      }
    }

    lap("sequence");
    if (context.channel === "email") {
      if (!contact.email?.trim()) {
        reasons.push("EMAIL_MISSING");
      } else {
        const provider = await evaluateMarketingEmailEligibility(contact.id);
        if (!provider.allowed) reasons.push("EMAIL_EVIDENCE_NOT_CURRENT");
        if (provider.evidenceAt) {
          evidenceRefs.push({
            authority: "email_validation",
            ref: provider.emailTokenHash ?? "current-token",
            version: EMAIL_VALIDATION_POLICY_VERSION,
          });
        }
      }
    } else if (!contact.phone?.trim()) {
      reasons.push("PHONE_MISSING");
    }

    lap("email_eligibility");
    try {
      const permission = await evaluateContactability({
        contactId: contact.id,
        channel: context.channel,
        campaignType: context.campaignId ? "marketing_campaign" : "promotional_enrollment",
        mode: "dryRun",
        currentTime: decidedAt,
      });
      if (!permission.allowed) reasons.push(normalizeContactabilityReason(permission.reason));
      evidenceRefs.push({ authority: "contactability", ref: fingerprint(permission.auditLogPayload), version: 1 });

      lap("contactability");
      // Task #1956 Step 8: data-hygiene dimension (DBPR-family lineage etc.) —
      // "Ready for Outreach" must never mark a DBPR-lineage record ready.
      const { evaluateContactDecisions } = await import("./contactability");
      const hygiene = await evaluateContactDecisions({ contactId: contact.id, businessId: (contact as any).businessId ?? null });
      if (hygiene.dataHygiene.status === "blocked") {
        reasons.push(...(hygiene.dataHygiene.reasonCodes as Cr04ReasonCode[]));
      }
      lap("hygiene");
    } catch {
      reasons.push("DEPENDENCY_UNAVAILABLE");
      decision = "unavailable";
    }
  }

  const orderedReasons = [...new Set(reasons)].sort();
  if (orderedReasons.length === 0) {
    decision = "qualified";
    orderedReasons.push("QUALIFIED");
  } else if (orderedReasons.some((r) => r.endsWith("_UNAVAILABLE") || r === "DEPENDENCY_UNAVAILABLE")) {
    decision = "unavailable";
  }

  const authoritySnapshot = {
    contactId,
    channel: context.channel,
    purpose: "marketing_outreach",
    policyVersion: CR04_POLICY_VERSION,
    taxonomyVersion: CR04_REASON_TAXONOMY_VERSION,
    readinessModelVersion: READINESS_MODEL_VERSION,
    commercialPolicyVersion: CRO02_POLICY_VERSION,
    emailValidationPolicyVersion: EMAIL_VALIDATION_POLICY_VERSION,
    sequenceId,
    campaignId: context.campaignId ?? null,
    contentVersion: context.contentVersion ?? (sequenceId ? `sequence-${sequenceId}` : null),
    senderVersion: context.senderVersion ?? "sender-policy-v1",
    replyRouteVersion: context.replyRouteVersion ?? "reply-route-v1",
    contactRevision: contact?.updatedAt?.toISOString() ?? null,
    emailGeneration: contact?.emailMutationGeneration ?? null,
    ownerBound: !!contact?.assignedTo,
    hasIcpEvidence: !!contact?.companyName && !!contact?.vertical,
    hasOfferEvidence: !!contact?.primaryOfferPath,
    evidenceRefs,
  };
  const authorityFingerprint = fingerprint(authoritySnapshot);
  const inputSnapshot = {
    ...authoritySnapshot,
    authorityFingerprint,
    // Immutable successor epoch refreshes expiry without changing the
    // substantive authority fingerprint used by frozen membership.
    decisionEpoch: Math.floor(decidedAt.getTime() / CR04_DECISION_TTL_MS),
  };
  const dependencyFingerprint = fingerprint(inputSnapshot);

  let id: string | null = null;
  if (context.persist !== false && contact) {
    let [stored] = await db.insert(cr04ChannelDecisions).values({
      contactId,
      channel: context.channel,
      purpose: "marketing_outreach",
      policyVersion: CR04_POLICY_VERSION,
      taxonomyVersion: CR04_REASON_TAXONOMY_VERSION,
      decision,
      reasonCodes: orderedReasons,
      dependencyFingerprint,
      inputSnapshot,
      evidenceRefs,
      commercialResolutionSnapshotId,
      decidedAt,
      expiresAt,
    }).onConflictDoNothing().returning({ id: cr04ChannelDecisions.id });
    if (!stored) {
      [stored] = await db.select({ id: cr04ChannelDecisions.id }).from(cr04ChannelDecisions).where(and(
        eq(cr04ChannelDecisions.contactId, contactId),
        eq(cr04ChannelDecisions.channel, context.channel),
        eq(cr04ChannelDecisions.purpose, "marketing_outreach"),
        eq(cr04ChannelDecisions.policyVersion, CR04_POLICY_VERSION),
        eq(cr04ChannelDecisions.dependencyFingerprint, dependencyFingerprint),
      )).limit(1);
    }
    id = stored?.id ?? null;
    lap("persist");
  }

  return {
    id,
    contactId,
    channel: context.channel,
    purpose: "marketing_outreach",
    policyVersion: CR04_POLICY_VERSION,
    taxonomyVersion: CR04_REASON_TAXONOMY_VERSION,
    decision,
    qualified: decision === "qualified",
    reasonCodes: orderedReasons,
    dependencyFingerprint,
    authorityFingerprint,
    decidedAt: decidedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    sequenceId,
    commercialResolutionSnapshotId,
  };
}

function scoreTier(score: number | null): "hot" | "warm" | "cold" | "unqualified" {
  if ((score ?? 0) >= 70) return "hot";
  if ((score ?? 0) >= 45) return "warm";
  if ((score ?? 0) >= 20) return "cold";
  return "unqualified";
}

export async function queryCr04ReadyProjection(input: {
  scope: Cr04ActorScope;
  filters?: Cr04ReadyFilters;
  /** Keyset continuation, not an offset into a post-qualified array. */
  cursor?: number;
  limit?: number;
  asOf?: Date;
}) {
  const filters = input.filters ?? {};
  const channel = filters.channel ?? "email";
  const cursor = input.cursor ?? 0;
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const candidateBudget = Math.max(limit, Math.min(500, limit * 10));
  if (input.scope.role !== "admin" && !input.scope.email) throw new Error("CR04_SCOPE_UNAVAILABLE");

  const params: unknown[] = [cursor];
  const conditions = ["c.archived_at IS NULL", "c.id > $1"];
  if (input.scope.role !== "admin") {
    params.push(input.scope.email);
    conditions.push(`c.assigned_to = $${params.length}`);
  } else if (filters.assignedTo) {
    if (filters.assignedTo === "unassigned") conditions.push("c.assigned_to IS NULL");
    else {
      params.push(filters.assignedTo);
      conditions.push(`c.assigned_to = $${params.length}`);
    }
  }
  if (filters.vertical) {
    params.push(filters.vertical);
    conditions.push(`c.vertical = $${params.length}`);
  }
  if (filters.city) {
    params.push(`%${filters.city.toLowerCase()}%`);
    conditions.push(`LOWER(COALESCE(c.city,'')) LIKE $${params.length}`);
  }
  if (filters.score === "hot") conditions.push("COALESCE(c.lead_score,0) >= 70");
  if (filters.score === "warm") conditions.push("COALESCE(c.lead_score,0) >= 45 AND COALESCE(c.lead_score,0) < 70");
  if (filters.score === "cold") conditions.push("COALESCE(c.lead_score,0) >= 20 AND COALESCE(c.lead_score,0) < 45");

  const rows = await pool.query(`
    SELECT c.id,c.first_name AS "firstName",c.last_name AS "lastName",
           c.company_name AS "companyName",c.email,c.phone,c.vertical,c.city,c.state,
           c.lead_score AS "leadScore",c.assigned_to AS "assignedTo",
           c.created_at AS "createdAt",c.last_scored_at AS "lastScoredAt",
           c.email_status AS "emailStatus",c.primary_offer_path AS "primaryOfferPath",
           c.data_readiness_score AS "dataReadinessScore"
      FROM contacts c
     WHERE ${conditions.join(" AND ")}
     ORDER BY c.id ASC
     LIMIT $${params.length + 1}
  `, [...params, candidateBudget]);

  const qualified: any[] = [];
  const reasonBuckets: Record<string, number> = {};
  let lastEvaluatedId = cursor;
  for (const row of rows.rows) {
    // Stop at the requested qualified page.  The next keyset starts after the
    // last decision actually evaluated, so no candidate is silently skipped.
    const decision = await evaluateCr04ChannelQualification(row.id, {
      channel,
      scope: input.scope,
      asOf: input.asOf,
    });
    lastEvaluatedId = row.id;
    for (const reason of decision.reasonCodes) reasonBuckets[reason] = (reasonBuckets[reason] ?? 0) + 1;
    if (decision.qualified) qualified.push({ ...row, scoreTier: scoreTier(row.leadScore), decision });
    if (qualified.length >= limit) break;
  }
  const assignees = [...new Set(qualified.map((row) => row.assignedTo as string | null))]
    .sort((a, b) => String(a ?? "").localeCompare(String(b ?? "")));
  return {
    data: qualified,
    // There is deliberately no total: deriving one needs an unbounded
    // qualification scan.  Consumers must treat this as a continuation page.
    total: null,
    exactTotal: false,
    cursor,
    nextCursor: lastEvaluatedId > cursor ? lastEvaluatedId : null,
    hasMore: rows.rows.length === candidateBudget || qualified.length === limit,
    limit,
    channel,
    policyVersion: CR04_POLICY_VERSION,
    taxonomyVersion: CR04_REASON_TAXONOMY_VERSION,
    asOf: (input.asOf ?? new Date()).toISOString(),
    reasonBuckets,
    assignees,
  };
}

export async function freezeCr04Cohort(input: {
  scope: Cr04ActorScope;
  channel: Cr04Channel;
  filters?: Cr04ReadyFilters;
  idempotencyKey: string;
  createdBy: string;
  asOf?: Date;
}) {
  const asOf = input.asOf ?? new Date();
  const filters = { ...(input.filters ?? {}), channel: input.channel };
  const scopeDocument = { role: input.scope.role, actorId: input.scope.actorId, emailBound: !!input.scope.email };
  const definitionFingerprint = fingerprint({
    purpose: "marketing_outreach",
    channel: input.channel,
    policyVersion: CR04_POLICY_VERSION,
    scope: scopeDocument,
    filters,
  });
  const run = await db.transaction(async (tx) => {
    let [definition] = await tx.select().from(cr04CohortDefinitions)
      .where(eq(cr04CohortDefinitions.definitionFingerprint, definitionFingerprint)).limit(1);
    if (!definition) {
      [definition] = await tx.insert(cr04CohortDefinitions).values({
        purpose: "marketing_outreach",
        channel: input.channel,
        policyVersion: CR04_POLICY_VERSION,
        scope: scopeDocument,
        filters,
        definitionFingerprint,
        createdBy: input.createdBy,
      }).onConflictDoNothing().returning();
      if (!definition) {
        [definition] = await tx.select().from(cr04CohortDefinitions)
          .where(eq(cr04CohortDefinitions.definitionFingerprint, definitionFingerprint)).limit(1);
      }
    }
    const [existing] = await tx.select().from(cr04CohortRuns).where(and(
      eq(cr04CohortRuns.definitionId, definition.id),
      eq(cr04CohortRuns.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    if (existing) return existing;
    const [run] = await tx.insert(cr04CohortRuns).values({
      definitionId: definition.id,
      idempotencyKey: input.idempotencyKey,
      status: "building",
      asOf,
      expiresAt: new Date(asOf.getTime() + CR04_COHORT_TTL_MS),
      memberCount: 0,
      membershipFingerprint: fingerprint([]),
      buildCursor: 0,
      reconciliationCursor: 0,
      buildPhase: "building",
      createdBy: input.createdBy,
    }).returning();
    return run;
  });

  // Terminal runs and cancellation replays are intentionally no-ops.  In
  // particular, cancellation is never converted back to a frozen cohort.
  if (run.status !== "building") return run;
  // A command-scoped lease serializes each bounded checkpoint.  The fence is
  // incremented only under the row lock, and every later checkpoint/finalize
  // write is conditional on this token/fence.  An expired owner can therefore
  // be safely taken over without allowing its late write to win.
  const leaseToken = randomUUID();
  const leased = await db.transaction(async (tx) => {
    const locked = await tx.execute(sql`SELECT status, lease_expires_at FROM cr04_cohort_runs WHERE id=${run.id}::uuid FOR UPDATE`);
    const row = (locked as any).rows?.[0];
    if (!row || row.status !== "building" ||
        (row.lease_expires_at && new Date(row.lease_expires_at) > new Date())) return null;
    const [claimed] = await tx.update(cr04CohortRuns).set({
      leaseOwner: leaseToken,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      buildFence: sql`${cr04CohortRuns.buildFence} + 1`,
    }).where(eq(cr04CohortRuns.id, run.id)).returning();
    return claimed;
  });
  // Another in-flight command owns a valid lease.  Return the durable state;
  // callers retry with the same idempotency key rather than racing it.
  if (!leased) return run;
  const heartbeat = async () => {
    const renewed = await db.update(cr04CohortRuns).set({
      leaseExpiresAt: new Date(Date.now() + 60_000),
    }).where(and(
      eq(cr04CohortRuns.id, leased.id),
      eq(cr04CohortRuns.status, "building"),
      eq(cr04CohortRuns.leaseOwner, leaseToken),
      eq(cr04CohortRuns.buildFence, leased.buildFence),
      sql`${cr04CohortRuns.leaseExpiresAt} > NOW()`,
    )).returning({ id: cr04CohortRuns.id });
    if (!renewed[0]) throw new Error("CR04_COHORT_LEASE_LOST");
  };
  // Idempotent resumes retain the run's authority instant; callers cannot
  // silently move a cohort's snapshot by retrying later.
  const runAsOf = leased.asOf;
  const phase = leased.buildPhase;
  if (phase !== "building" && phase !== "reconciling") throw new Error("CR04_COHORT_BUILD_STATE_INVALID");

  if (phase === "building") {
    const params: unknown[] = [leased.buildCursor];
    const conditions = ["c.archived_at IS NULL", "c.id > $1"];
    if (input.scope.role !== "admin") {
      params.push(input.scope.email);
      conditions.push(`c.assigned_to = $${params.length}`);
    } else if (filters.assignedTo) {
      if (filters.assignedTo === "unassigned") conditions.push("c.assigned_to IS NULL");
      else { params.push(filters.assignedTo); conditions.push(`c.assigned_to = $${params.length}`); }
    }
    if (filters.vertical) { params.push(filters.vertical); conditions.push(`c.vertical = $${params.length}`); }
    if (filters.city) { params.push(`%${filters.city.toLowerCase()}%`); conditions.push(`LOWER(COALESCE(c.city,'')) LIKE $${params.length}`); }
    if (filters.score === "hot") conditions.push("COALESCE(c.lead_score,0) >= 70");
    if (filters.score === "warm") conditions.push("COALESCE(c.lead_score,0) >= 45 AND COALESCE(c.lead_score,0) < 70");
    if (filters.score === "cold") conditions.push("COALESCE(c.lead_score,0) >= 20 AND COALESCE(c.lead_score,0) < 45");
    params.push(CR04_COHORT_BATCH_SIZE);
    const candidates = await pool.query(`SELECT c.id FROM contacts c WHERE ${conditions.join(" AND ")}
      ORDER BY c.id ASC LIMIT $${params.length}`, params);
    let rolling = leased.membershipFingerprint;
    let count = leased.memberCount;
    const additions: Array<{ runId: string; ordinal: number; contactId: number; decisionId: string; dependencyFingerprint: string }> = [];
    for (const candidate of candidates.rows) {
      await heartbeat();
      const decision = await evaluateCr04ChannelQualification(candidate.id, {
        channel: input.channel, scope: input.scope, asOf: runAsOf, persist: true,
      });
      if (decision.qualified && decision.id) {
        count++;
        rolling = fingerprint([rolling, candidate.id, decision.dependencyFingerprint]);
        additions.push({ runId: leased.id, ordinal: count, contactId: candidate.id, decisionId: decision.id, dependencyFingerprint: decision.dependencyFingerprint });
      }
    }
    const buildComplete = candidates.rows.length < CR04_COHORT_BATCH_SIZE;
    const nextCursor = buildComplete ? leased.buildCursor : candidates.rows[candidates.rows.length - 1].id;
    await db.transaction(async (tx) => {
      const locked = await tx.execute(sql`SELECT status FROM cr04_cohort_runs WHERE id=${leased.id}::uuid AND lease_owner=${leaseToken} AND build_fence=${leased.buildFence} AND lease_expires_at > NOW() FOR UPDATE`);
      if ((locked as any).rows?.[0]?.status !== "building") return;
      if (additions.length) await tx.insert(cr04CohortMembers).values(additions).onConflictDoNothing();
      await tx.update(cr04CohortRuns).set({
        memberCount: count, membershipFingerprint: rolling, buildCursor: nextCursor,
        buildPhase: buildComplete ? "reconciling" : "building",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      })
        .where(and(eq(cr04CohortRuns.id, leased.id), eq(cr04CohortRuns.status, "building"),
          eq(cr04CohortRuns.leaseOwner, leaseToken), eq(cr04CohortRuns.buildFence, leased.buildFence)));
    });
  } else {
    // Reconciliation is separate and equally bounded.  A member may only be
    // frozen after its current authority fingerprint exactly matches the
    // recorded qualified decision.
    const members = await db.select({
      ordinal: cr04CohortMembers.ordinal, contactId: cr04CohortMembers.contactId,
      authorityFingerprint: cr04ChannelDecisions.inputSnapshot,
    }).from(cr04CohortMembers).innerJoin(cr04ChannelDecisions,
      eq(cr04ChannelDecisions.id, cr04CohortMembers.decisionId))
      .where(and(eq(cr04CohortMembers.runId, leased.id), sql`${cr04CohortMembers.ordinal} > ${leased.reconciliationCursor}`))
      .orderBy(asc(cr04CohortMembers.ordinal)).limit(CR04_COHORT_BATCH_SIZE);
    for (const member of members) {
      await heartbeat();
      const current = await evaluateCr04ChannelQualification(member.contactId, {
        channel: input.channel, scope: input.scope, asOf: runAsOf, persist: true,
      });
      if (!current.qualified || (member.authorityFingerprint as any)?.authorityFingerprint !== current.authorityFingerprint) {
        await db.update(cr04CohortRuns).set({ status: "failed", failedAt: new Date(), failureCode: "FINAL_RECONCILIATION_FAILED" })
          .where(and(eq(cr04CohortRuns.id, leased.id), eq(cr04CohortRuns.status, "building"),
            eq(cr04CohortRuns.leaseOwner, leaseToken), eq(cr04CohortRuns.buildFence, leased.buildFence),
            sql`${cr04CohortRuns.leaseExpiresAt} > NOW()`));
        throw new Error("CR04_COHORT_FINAL_RECONCILIATION_FAILED");
      }
    }
    if (members.length < CR04_COHORT_BATCH_SIZE) {
      await db.update(cr04CohortRuns).set({
        status: "frozen", frozenAt: new Date(), buildPhase: "complete",
        leaseOwner: null, leaseExpiresAt: null,
      }).where(and(eq(cr04CohortRuns.id, leased.id), eq(cr04CohortRuns.status, "building"),
        eq(cr04CohortRuns.leaseOwner, leaseToken), eq(cr04CohortRuns.buildFence, leased.buildFence),
        sql`${cr04CohortRuns.leaseExpiresAt} > NOW()`));
    } else {
      await db.update(cr04CohortRuns).set({
        reconciliationCursor: members[members.length - 1].ordinal,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      }).where(and(eq(cr04CohortRuns.id, leased.id), eq(cr04CohortRuns.status, "building"),
        eq(cr04CohortRuns.leaseOwner, leaseToken), eq(cr04CohortRuns.buildFence, leased.buildFence),
        sql`${cr04CohortRuns.leaseExpiresAt} > NOW()`));
    }
  }
  const [updated] = await db.select().from(cr04CohortRuns).where(eq(cr04CohortRuns.id, leased.id)).limit(1);
  return updated!;
}

export async function enrollThroughCr04Fence(input: {
  contactId: number;
  sequenceId: number;
  channel: Cr04Channel;
  idempotencyKey: string;
  source: string;
  actor: Cr04ActorScope;
  programId?: string | null;
  cohortRunId?: string | null;
  dealId?: number | null;
  nextActionAt?: Date;
}) {
  if (input.channel === "email") {
    const { prepareCanonicalRecipient } = await import("./canonical-recipient-preparation");
    return prepareCanonicalRecipient({
      contactId: input.contactId, sequenceId: input.sequenceId, programId: input.programId,
      actor: input.actor, source: input.source, dealId: input.dealId,
      historicalCohortRunId: input.cohortRunId,
    });
  }
  const replay = await db.select().from(cr04EnrollmentIntents)
    .where(eq(cr04EnrollmentIntents.idempotencyKey, input.idempotencyKey)).limit(1);
  if (replay[0]) return { replayed: true, intent: replay[0], enrollmentId: replay[0].enrollmentId };

  if (!input.cohortRunId) {
    return { replayed: false, blocked: true, reasonCode: "COHORT_REQUIRED", enrollmentId: null };
  }
  const cohortRunId = input.cohortRunId;
  const [{ authorize }, { canExecute }] = await Promise.all([
    import("./outbound-pause-authority"),
    import("./outbound-queue-coordinator"),
  ]);
  const pauseDecision = await authorize({});
  const coordinatorAllowed = await canExecute("sequence-processing");
  if (!pauseDecision.allowed || !coordinatorAllowed) {
    return {
      replayed: false,
      blocked: true,
      reasonCode: !pauseDecision.allowed ? `OUTBOUND_${pauseDecision.reasonCode}` : "OUTBOUND_COORDINATOR_HELD",
      enrollmentId: null,
    };
  }
  const sequenceChannelRows = await db.select({ actionType: sequenceSteps.actionType })
    .from(sequenceSteps).where(eq(sequenceSteps.sequenceId, input.sequenceId));
  const sequenceChannels = [...new Set(sequenceChannelRows
    .map((step) => channelForStep(step.actionType))
    .filter((channel): channel is Cr04Channel => channel !== null))];
  if (!sequenceChannels.includes(input.channel)) sequenceChannels.unshift(input.channel);
  const decisions = await Promise.all(sequenceChannels.map((channel) =>
    evaluateCr04ChannelQualification(input.contactId, {
      channel,
      sequenceId: input.sequenceId,
      scope: input.actor,
    }),
  ));
  const decision = decisions.find((entry) => entry.channel === input.channel) ?? decisions[0];
  const blockedDecision = decisions.find((entry) => !entry.qualified || !entry.id);
  if (blockedDecision || !decision?.id) {
    return { replayed: false, blocked: true, decision: blockedDecision ?? decision, decisions, enrollmentId: null };
  }

  return db.transaction(async (tx) => {
    const lockedResult = await tx.execute(sql`
      SELECT id, archived_at, do_not_contact, outreach_queue_skipped_at, assigned_to, updated_at
        FROM contacts WHERE id=${input.contactId} FOR UPDATE
    `);
    const locked = (lockedResult as any).rows?.[0];
    if (!locked) throw new Error("CR04_CONTACT_NOT_FOUND");
    if (locked.archived_at || locked.do_not_contact || locked.outreach_queue_skipped_at || !locked.assigned_to) {
      return { replayed: false, blocked: true, reasonCode: "LOCKED_RECHECK_BLOCKED", enrollmentId: null };
    }
    if (input.actor.role !== "admin" && locked.assigned_to !== input.actor.email) {
      return { replayed: false, blocked: true, reasonCode: "OUT_OF_SCOPE", enrollmentId: null };
    }
    const runResult = await tx.execute(sql`
      SELECT id,status,expires_at
        FROM cr04_cohort_runs
       WHERE id=${cohortRunId}::uuid
       FOR UPDATE
    `);
    const lockedRun = (runResult as any).rows?.[0];
    const now = new Date();
    if (!lockedRun || !["frozen", "consumed"].includes(lockedRun.status) ||
        new Date(lockedRun.expires_at) <= now) {
      return { replayed: false, blocked: true, reasonCode: "COHORT_NOT_EXECUTABLE", enrollmentId: null };
    }
    const [member] = await tx.select({
      runId: cr04CohortMembers.runId,
      decisionId: cr04CohortMembers.decisionId,
      removedAt: cr04CohortMembers.removedAt,
      runStatus: cr04CohortRuns.status,
      runExpiresAt: cr04CohortRuns.expiresAt,
      decisionExpiresAt: cr04ChannelDecisions.expiresAt,
      decisionChannel: cr04ChannelDecisions.channel,
      decisionValue: cr04ChannelDecisions.decision,
      decisionFingerprint: cr04ChannelDecisions.dependencyFingerprint,
      decisionInputSnapshot: cr04ChannelDecisions.inputSnapshot,
      memberFingerprint: cr04CohortMembers.dependencyFingerprint,
    }).from(cr04CohortMembers)
      .innerJoin(cr04CohortRuns, eq(cr04CohortRuns.id, cr04CohortMembers.runId))
      .innerJoin(cr04ChannelDecisions, eq(cr04ChannelDecisions.id, cr04CohortMembers.decisionId))
      .where(and(
        eq(cr04CohortMembers.runId, cohortRunId),
        eq(cr04CohortMembers.contactId, input.contactId),
      )).limit(1);
    if (!member || member.removedAt || !["frozen", "consumed"].includes(member.runStatus) ||
        member.runExpiresAt <= now || member.decisionExpiresAt <= now ||
        member.decisionChannel !== input.channel || member.decisionValue !== "qualified" ||
         member.memberFingerprint !== member.decisionFingerprint ||
         member.memberFingerprint !== decision.dependencyFingerprint ||
        (member.decisionInputSnapshot as any)?.authorityFingerprint !== decision.authorityFingerprint) {
      return { replayed: false, blocked: true, reasonCode: "COHORT_MEMBER_NOT_CURRENT", enrollmentId: null };
    }
    const [existing] = await tx.select({ id: sequenceEnrollments.id }).from(sequenceEnrollments)
      .where(and(
        eq(sequenceEnrollments.contactId, input.contactId),
        sql`${sequenceEnrollments.status} IN ('active','paused')`,
      )).limit(1);
    const [intent] = await tx.insert(cr04EnrollmentIntents).values({
      idempotencyKey: input.idempotencyKey,
      contactId: input.contactId,
      sequenceId: input.sequenceId,
      channel: input.channel,
      source: input.source,
      actorId: input.actor.actorId,
      decisionId: decision.id!,
      cohortRunId,
      // CR-04 is not an activation authority. Even a qualified frozen member
      // is recorded as a blocked execution attempt until the later pilot
      // authority can perform an atomic current-state recheck.
      status: "blocked",
      reasonCode: "ACTIVATION_AUTHORITY_NOT_ENABLED",
      enrollmentId: existing?.id ?? null,
      completedAt: new Date(),
    }).onConflictDoNothing().returning();
    if (!intent) {
      const [won] = await tx.select().from(cr04EnrollmentIntents)
        .where(eq(cr04EnrollmentIntents.idempotencyKey, input.idempotencyKey)).limit(1);
      return { replayed: true, intent: won, enrollmentId: won?.enrollmentId ?? null };
    }
    if (existing) return { replayed: false, intent, enrollmentId: existing.id, alreadyEnrolled: true };
    // No approved/promotable intent is emitted and the run stays frozen.
    // Pilot activation must atomically consume it with the successful action.
    return {
      replayed: false,
      blocked: true,
      intent,
      enrollmentId: null,
      decision,
      reasonCode: "ACTIVATION_AUTHORITY_NOT_ENABLED",
    };
  });
}