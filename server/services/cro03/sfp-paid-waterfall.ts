/** Bounded, ROI-ordered paid escalation for the South Florida program. */
import { sql } from "drizzle-orm";
import { programDiscoverySelection, type DiscoveryScope } from "./sfp-discovery-scope";
import {
  claimSerperLookup, recordSerperLookupOutcome, releaseSerperLookupClaim,
} from "./sfp-serper-lookup-memory";
import {
  UNLABELED_DISCOVERY_CALLER, createDurableRequestAllowance,
  readUnlabeledDiscoveryGate, type RequestAllowance,
} from "./sfp-serper-allowance";
import { createHash, randomUUID } from "node:crypto";
import { db } from "../../db";
import { getPaidProviderControls } from "../paid-provider-control";
import { lookupBusinessIdentity } from "../serper-business-identity";
import { runFreeEnrichmentLane } from "../free-enrichment-lane";
import {
  normalizeSfpProviderUsage,
  type SfpProviderUsageSettlement,
} from "./sfp-billing-contract";
import {
  assertCurrentSfpProviderReservation,
  invokeSfpProviderTransport,
  currentSfpUnitPrice,
  finishSfpProviderOperation,
  reconcileSfpProviderUsage,
  reserveSfpProviderOperation,
  settleSfpProviderOperation,
  type SfpProviderReservation,
} from "./sfp-provider-operations";
import {
  executeSfpApolloDiscovery, executeSfpOutscraperDiscovery,
} from "./sfp-live-provider-adapters";
import {
  performOutscraperLeadsAndContacts, performOutscraperTaskResults,
  type OutscraperBusiness, type OutscraperUsageReceipt,
} from "../sdr/outscraper";
import {
  calculateApolloRequestWork, deriveOutscraperResultRetentionBound,
  documentedApolloSearchCredits, parseApolloUsageReceipt, type ApolloEmployerScope,
} from "../sdr/sfp-provider-contracts";
import { writeSfpPaidCandidateEvidence } from "./sfp-paid-evidence-writer";
import { sfpUnavailableHttpReason } from "./sfp-continuous-progress";
import {
  computeContactLinkReuse,
  computeSfpGapVector,
  hasResolvedBusinessIdentity,
  isResolvedSouthFloridaGeographyOutcome,
  stopConditionsMet,
} from "./sfp-contact-gap-vector";
import { candidateTier, rejectEmailCandidate } from "./candidate-selector";
import { getSfpCohortGapSnapshot } from "./sfp-cost-preview";
import { buildSfpProviderHttpDiagnostics } from "./sfp-provider-http-diagnostics";

const rows = (r: any): any[] => r?.rows ?? r ?? [];
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ROUTINE_SFP_CALLER = "server/services/cro03/sfp-paid-waterfall.ts";

function providerUsage(
  status: "known" | "unknown" | "conflict",
  unit: string,
  quantity?: string,
  providerRequestId?: string | null,
  source?: string,
): SfpProviderUsageSettlement {
  return normalizeSfpProviderUsage({
    status,
    quantity: status === "known" ? quantity ?? null : null,
    unit: status === "known" ? unit : null,
    providerRequestId: providerRequestId ?? null,
    source: source ?? null,
  });
}

/**
 * Route exact provider usage through the generic completion API. Work counters
 * stay integer and explicitly carry the reservation's declared work unit.
 */
async function finishSfpOperation(input: {
  reservation: SfpProviderReservation;
  outcome: "completed" | "no_result" | "failed" | "ambiguous" | "not_dispatched";
  observation: "valid" | "invalid" | "risky" | "unknown" | "no_result" | "transport";
  businessId: number;
  workCompleted: number;
  providerUsage: SfpProviderUsageSettlement;
  resultData?: Record<string, unknown>;
}, executor?: { execute: (query: any) => Promise<any> }) {
  if (!Number.isSafeInteger(input.workCompleted) || input.workCompleted < 0) {
    throw new Error("SFP_PROVIDER_WORK_COMPLETED_INVALID");
  }
  const usage = normalizeSfpProviderUsage(input.providerUsage);
  if (input.workCompleted > input.reservation.units) {
    throw new Error("SFP_PROVIDER_WORK_COMPLETED_EXCEEDS_RESERVED_UNITS");
  }
  const resultData = {
    ...input.resultData,
    providerReference: usage.providerRequestId,
  };
  const finished = await finishSfpProviderOperation({
    reservation: input.reservation,
    outcome: input.outcome,
    observation: input.observation,
    businessId: input.businessId,
    workUnit: input.reservation.workUnit,
    workCompleted: input.workCompleted,
    providerUsage: usage,
    resultData: resultData as Parameters<typeof finishSfpProviderOperation>[0]["resultData"],
  }, executor);
  // Reconcile every exact provider receipt independently by request ID. This
  // is deliberately one HTTP-request receipt at a time, never an aggregate.
  if (!executor && usage.status === "known" && usage.providerRequestId) {
    await reconcileSfpUsageByRequest({
      provider: input.reservation.provider,
      workUnit: input.reservation.workUnit,
      providerUsage: usage,
      reconciliationSource: usage.source ?? "sfp_provider_receipt",
    });
  }
  return finished;
}

async function reconcileSfpUsageByRequest(input: {
  provider: SfpProviderReservation["provider"];
  workUnit: string;
  providerUsage: SfpProviderUsageSettlement;
  reconciliationSource?: string;
}): Promise<void> {
  await reconcileSfpProviderUsage(input);
}

function canonicalDomain(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`)
      .hostname.replace(/^www\./i, "").toLowerCase() || null;
  } catch { return null; }
}

function normalizedIdentity(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  return normalized || null;
}

function outscraperMatchesPinnedBusiness(place: OutscraperBusiness, target: {
  canonical_name: unknown; website_domain?: unknown; city?: unknown; state?: unknown;
}): boolean {
  const expectedDomain = canonicalDomain(target.website_domain);
  const resultDomain = canonicalDomain(place.website);
  const expectedCity = normalizedIdentity(target.city);
  const expectedState = normalizedIdentity(target.state);
  const cityMatches = !expectedCity || normalizedIdentity(place.city) === expectedCity;
  const stateMatches = !expectedState || normalizedIdentity(place.state) === expectedState;
  if (!cityMatches || !stateMatches) return false;
  if (expectedDomain) return resultDomain === expectedDomain;
  // Without a pinned domain, exact legal/business name plus both known
  // locality values is the minimum safe organization resolution contract.
  return Boolean(expectedCity && expectedState &&
    normalizedIdentity(place.name) === normalizedIdentity(target.canonical_name));
}

function outscraperResultHash(place: OutscraperBusiness): string {
  return sha256({
    name: place.name,
    website: canonicalDomain(place.website),
    city: normalizedIdentity(place.city),
    state: normalizedIdentity(place.state),
    placeId: place.placeId,
  });
}

function businessCandidateValues(place: OutscraperBusiness): Array<{ field: string; value: string }> {
  const values: Array<{ field: string; value: string }> = [];
  for (const field of ["name", "phone", "email", "website", "address", "city", "state", "zip", "category"] as const) {
    const value = place[field];
    if (typeof value === "string" && value.trim() &&
        (field !== "email" || !rejectEmailCandidate(value, "business"))) {
      values.push({ field, value: value.trim() });
    }
  }
  for (const [field, value] of [["rating", place.rating], ["review_count", place.reviewCount], ["place_id", place.placeId]] as const) {
    if (value !== null && value !== undefined && String(value).trim()) values.push({ field, value: String(value) });
  }
  return values;
}

function namedOutscraperEmailCandidates(place: OutscraperBusiness): Array<{
  email: string; name: string; title: string;
}> {
  return place.contacts.flatMap((contact) => {
    if (!contact.name || !contact.title) return [];
    return contact.emails.filter((email) => !rejectEmailCandidate(email, "person"))
      .map((email) => ({ email, name: contact.name!, title: contact.title! }));
  });
}

async function persistOutscraperTaskSubmission(input: {
  task: { requestId: string; state: "submitted" | "pending" | "completed" | "failed" };
  requestFingerprint: string;
  businessId: number;
  businessName: string;
  domain: string | null;
  city: string | null;
  state: string | null;
  stageRunId: string;
  cohortRunId?: string;
  reservation: SfpProviderReservation;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const submissionAttempt = rows(await tx.execute(sql`
      SELECT started_at
        FROM provider_operations
       WHERE id=${input.reservation.operationId}::uuid
         AND claim_token=${input.reservation.claimToken}::uuid
       FOR UPDATE
    `))[0];
    if (!submissionAttempt?.started_at) throw new Error("OUTSCRAPER_SUBMISSION_START_UNKNOWN");
    const submittedAt = new Date(submissionAttempt.started_at).toISOString();
    const completionLowerBound = input.task.state === "pending"
      ? new Date().toISOString()
      : submittedAt;
    const completionBoundKind = input.task.state === "pending"
      ? "last_pending_observed" : "submission_started";
    const inserted = rows(await tx.execute(sql`
      INSERT INTO sfp_provider_retrieval_tasks
        (provider,task_kind,provider_task_id,provider_reference,submission_operation_id,
         stage_run_id,cohort_run_id,business_id,business_name_snapshot,domain_snapshot,
         city_snapshot,state_snapshot,state,request_fingerprint,submitted_at,next_poll_at,
         completion_time_lower_bound_at,completion_time_bound_kind,results_expires_at,expires_at)
      VALUES ('outscraper','maps_search',${input.task.requestId},${input.task.requestId},
              ${input.reservation.operationId}::uuid,${input.stageRunId}::uuid,${input.cohortRunId ?? null}::uuid,
              ${input.businessId},${input.businessName},${input.domain},${input.city},${input.state},
              'submitted',${input.requestFingerprint},${submittedAt}::timestamptz,NOW()+INTERVAL '30 seconds',
              ${completionLowerBound}::timestamptz,${completionBoundKind},
              ${completionLowerBound}::timestamptz+INTERVAL '4 hours',
              ${submittedAt}::timestamptz+INTERVAL '24 hours')
      ON CONFLICT(provider,provider_task_id) DO NOTHING
      RETURNING id
    `))[0];
    if (!inserted) {
      const existing = rows(await tx.execute(sql`
        SELECT id,business_id,stage_run_id,submission_operation_id,request_fingerprint
          FROM sfp_provider_retrieval_tasks
         WHERE provider='outscraper' AND provider_task_id=${input.task.requestId}
      `))[0];
      if (!existing || Number(existing.business_id) !== input.businessId ||
          String(existing.stage_run_id) !== input.stageRunId ||
          String(existing.submission_operation_id) !== input.reservation.operationId ||
          String(existing.request_fingerprint) !== input.requestFingerprint) {
        throw new Error("OUTSCRAPER_TASK_IDENTITY_CONFLICT");
      }
    }
    const persistedRequest = rows(await tx.execute(sql`
      UPDATE provider_operations
         SET provider_request_id=${input.task.requestId},
             sfp_result_data=COALESCE(sfp_result_data,'{}'::jsonb) ||
               ${JSON.stringify({
                 retrievalState: "submitted",
                 providerReference: input.task.requestId,
                 externalTaskId: input.task.requestId,
                 requestFingerprint: input.requestFingerprint,
               })}::jsonb,
             updated_at=NOW()
       WHERE id=${input.reservation.operationId}::uuid
         AND claim_token=${input.reservation.claimToken}::uuid
         AND state='running' AND billing_state='reserved'
       RETURNING id
    `))[0];
    if (!persistedRequest) throw new Error("OUTSCRAPER_TASK_SUBMISSION_FENCE_LOST");
    await tx.execute(sql`
      UPDATE sfp_stage_items
         SET state='retry',claim_token=NULL,lease_expires_at=NULL,
             outcome_code='outscraper_task_submitted',
             redacted_result=${JSON.stringify({
               retrievalState: "submitted", providerReference: input.task.requestId,
               requestFingerprint: input.requestFingerprint,
             })}::jsonb,updated_at=NOW()
       WHERE provider_operation_id=${input.reservation.operationId}::uuid
    `);
  });
}

async function claimStageRun(stageRunId: string): Promise<string> {
  // 'partial' means a prior attempt under this same idempotency key finished
  // (cleared its lease) with some items unresolved — e.g. every item failed
  // because a paid provider was disabled at the time. Its lease is already
  // NULL (see the UPDATE at the bottom of executeSfpSerperDiscovery), so it
  // is safe to reclaim exactly like 'authorized'/'pending'. Excluding it was
  // a bug: once a stage ever went 'partial', no later tick within the same
  // idempotency window could ever retry it, and the caller saw a misleading
  // "already running" error for what was really "nothing left to claim".
  const claimed = rows(await db.execute(sql`
    UPDATE sfp_stage_runs
       SET state='running',claim_token=gen_random_uuid(),lease_expires_at=NOW()+INTERVAL '30 minutes',
           started_at=COALESCE(started_at,NOW()),last_heartbeat_at=NOW(),updated_at=NOW()
     WHERE id=${stageRunId}::uuid AND (
       state IN ('authorized','pending','partial') OR (state='running' AND lease_expires_at<NOW())
     )
    RETURNING claim_token
  `))[0];
  if (!claimed) throw new Error("SFP_STAGE_ALREADY_RUNNING");
  return String(claimed.claim_token);
}

async function renewStageRunClaim(stageRunId: string, claimToken: string): Promise<void> {
  const renewed = rows(await db.execute(sql`
    UPDATE sfp_stage_runs SET lease_expires_at=NOW()+INTERVAL '30 minutes',last_heartbeat_at=NOW(),updated_at=NOW()
     WHERE id=${stageRunId}::uuid AND state='running' AND claim_token=${claimToken}::uuid
       AND lease_expires_at>NOW()
    RETURNING id
  `))[0];
  if (!renewed) throw new Error("SFP_STAGE_CLAIM_LOST");
}

async function buildCurrentGapVector(input: {
  cohortRunId?: string;
  geography?: any;
  businessId: number;
  reuse: {
    hasVerifiedContact: boolean; hasVerifiedNamedDecisionMaker: boolean;
    verifiedLinks?: Array<{ decisionId: string | number; contactName?: string | null; contactTitle?: string | null }>;
  };
  apolloSkipReason?: string | null;
  outscraperSkipReason?: string | null;
}) {
  const decision = rows(await db.execute(sql`
    SELECT classifier_outcome,geography_outcome,geography_location_id,suppression_subjects,
           suppression_business_wide_rule_applied,classification_evidence_id
      FROM sfp_cohort_decisions
     WHERE cohort_run_id=${input.cohortRunId ?? null}::uuid AND business_id=${input.businessId}
     LIMIT 1
  `))[0];
  const business = rows(await db.execute(sql`
    SELECT website_domain,vertical,main_phone,street_address,city
      FROM businesses WHERE id=${input.businessId}
  `))[0];
  const free = rows(await db.execute(sql`
    SELECT id FROM free_discovery_candidates
     WHERE business_id=${input.businessId} AND field IN ('email','phone')
       AND disposition IN ('staged','validation_admitted','accepted')
     ORDER BY created_at DESC LIMIT 1
  `))[0];
  const paid = rows(await db.execute(sql`
    SELECT id FROM sfp_paid_candidate_evidence
     WHERE business_id=${input.businessId} AND field IN ('email','phone')
       AND disposition IN ('staged','accepted')
     ORDER BY created_at DESC LIMIT 1
  `))[0];
  const paidNamedDecisionMaker = rows(await db.execute(sql`
    SELECT id FROM sfp_paid_candidate_evidence
     WHERE business_id=${input.businessId} AND provider='apollo' AND subject_type='person'
       AND NULLIF(BTRIM(person_name_evidence),'') IS NOT NULL
       AND NULLIF(BTRIM(person_title_evidence),'') IS NOT NULL
       AND disposition IN ('staged','accepted')
     ORDER BY created_at DESC LIMIT 1
  `))[0];
  const contactRows = rows(await db.execute(sql`
    SELECT id,email,COALESCE(opted_out_email,FALSE) AS opted_out_email,
           unsubscribe_status,bounce_status
      FROM contacts WHERE business_id=${input.businessId}
       AND (COALESCE(opted_out_email,FALSE)=TRUE OR unsubscribe_status IN ('unsubscribed','complained')
            OR bounce_status IN ('hard','blocked'))
  `));
  const domainEvidence = rows(await db.execute(sql`
    SELECT id FROM sfp_paid_candidate_evidence
     WHERE business_id=${input.businessId} AND provider='serper' AND field='website_domain'
       AND disposition IN ('staged','accepted')
     ORDER BY created_at DESC LIMIT 1
  `))[0];
  let storedSuppressions: any[] = [];
  try {
    storedSuppressions = typeof decision?.suppression_subjects === "string"
      ? JSON.parse(decision.suppression_subjects) : decision?.suppression_subjects ?? [];
  } catch { storedSuppressions = []; }
  const subjectSuppressions = [
    ...storedSuppressions,
    ...contactRows.map((contact: any) => ({
      subjectHash: sha256(String(contact.email ?? contact.id).trim().toLowerCase()),
      authority: "canonical_contact_suppression_state",
      reasonCode: contact.bounce_status ? `bounce_${contact.bounce_status}` : String(contact.unsubscribe_status ?? "opted_out"),
      channel: "email",
      scope: "email" as const,
    })),
  ];
  const verifiedDecision = input.reuse.verifiedLinks?.find((verified) => verified.contactName && verified.contactTitle);
  return computeSfpGapVector({
    businessId: input.businessId,
    // Cohort membership itself is the persisted proof that the same resolver
    // accepted geography at freeze time; retain its actual outcome evidence.
    geographyResolved: input.geography ? input.geography.eligible && input.geography.outcome==="resolved"
      : isResolvedSouthFloridaGeographyOutcome(decision?.geography_outcome),
    targetVerticalResolved: input.geography ? true
      : ["resolved_high", "resolved_medium"].includes(String(decision?.classifier_outcome)),
    officialDomainKnown: Boolean(business?.website_domain),
    businessIdentityResolved: hasResolvedBusinessIdentity({
      mainPhone: business?.main_phone,
      streetAddress: business?.street_address,
      city: business?.city,
    }),
    hasFreeDiscoveryContactCandidate: Boolean(free),
    hasPaidContactCandidate: Boolean(paid),
    hasPaidNamedDecisionMaker: Boolean(paidNamedDecisionMaker),
    verifiedLinkReuse: input.reuse,
    subjectSuppressions,
    businessWideSuppressionApplied: Boolean(decision?.suppression_business_wide_rule_applied),
    evidenceRefs: {
      geography: decision?.geography_location_id == null ? null : `business_location:${decision.geography_location_id}`,
      target_vertical: decision?.classification_evidence_id ? `classification_evidence:${decision.classification_evidence_id}` : null,
      official_domain: domainEvidence?.id ? `paid_candidate_evidence:${domainEvidence.id}` : null,
      business_identity: hasResolvedBusinessIdentity({
        mainPhone: business?.main_phone,
        streetAddress: business?.street_address,
        city: business?.city,
      }) ? `business:${input.businessId}` : null,
      business_contact_channel: paid?.id ? `paid_candidate_evidence:${paid.id}` : free?.id ? `free_discovery_candidate:${free.id}` : null,
      named_decision_maker: verifiedDecision
        ? `decision:${verifiedDecision.decisionId}`
        : paidNamedDecisionMaker?.id
          ? `paid_candidate_evidence:${paidNamedDecisionMaker.id}`
          : null,
    },
    apolloSkipReason: input.apolloSkipReason,
    outscraperSkipReason: input.outscraperSkipReason,
  });
}

export async function previewSfpPaidWaterfall(cohortRunId: string) {
  const cohort = rows(await db.execute(sql`
    SELECT r.id,r.cohort_hash,r.cohort_state,r.voided_at,r.superseded_at,p.is_active
      FROM sfp_cohort_runs r JOIN sfp_programs p ON p.id=r.program_id
     WHERE r.id=${cohortRunId}::uuid
  `))[0];
  if (!cohort) throw new Error("SFP_COHORT_RUN_NOT_FOUND");
  if (cohort.cohort_state !== "frozen" || cohort.voided_at || cohort.superseded_at) {
    throw new Error(`SFP_COHORT_NOT_USABLE:state=${cohort.cohort_state}`);
  }
  const eligible = rows(await db.execute(sql`
    SELECT COUNT(*)::int AS count FROM sfp_cohort_members m
     WHERE m.cohort_run_id=${cohortRunId}::uuid
       AND NOT EXISTS (SELECT 1 FROM free_discovery_candidates c
                        WHERE c.business_id=m.business_id AND c.disposition IN ('staged','validation_admitted'))
  `))[0];
  const serperReady = rows(await db.execute(sql`
    SELECT COUNT(*)::int AS count FROM sfp_cohort_members m
    JOIN businesses b ON b.id=m.business_id
    WHERE m.cohort_run_id=${cohortRunId}::uuid AND b.website_domain IS NULL
      AND NOT EXISTS (SELECT 1 FROM free_discovery_candidates c
        WHERE c.business_id=b.id AND c.disposition IN ('staged','validation_admitted'))
      AND NOT EXISTS (SELECT 1 FROM sfp_identity_quarantines q
        WHERE q.business_id=b.id AND q.cleared_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM sfp_stage_items i
        JOIN sfp_stage_runs prior ON prior.id=i.stage_run_id
        WHERE prior.cohort_run_id=m.cohort_run_id AND i.business_id=b.id
          AND i.provider='serper' AND i.state IN ('completed','no_result'))
      AND NOT EXISTS (SELECT 1 FROM sfp_stage_items i
        WHERE i.business_id=b.id AND i.provider='serper' AND i.state='no_result'
          AND i.completed_at >= NOW() - INTERVAL '24 hours')
  `))[0];
  const controls = await getPaidProviderControls();
  const supported = new Set(["serper", "outscraper", "apollo"]);
  return {
    cohortRunId,
    programActive:Boolean(cohort.is_active),
    businessesNeedingPaidDiscovery:Number(eligible?.count ?? 0),
    serperEligibleNow:Number(serperReady?.count ?? 0),
    providers: await Promise.all(controls.providers.map(async (p: any) => ({
      ...p,
      executableForSfp: supported.has(String(p.provider)),
      unitPriceMicros: supported.has(String(p.provider))
        ? await currentSfpUnitPrice(p.provider === "openai" ? "openai_classification" : p.provider as any).catch(() => null) : null,
      role: p.provider === "serper" ? "find/corroborate the official domain, then rerun the free first-party crawler"
        : p.provider === "zerobounce" ? "validation stage, not discovery"
        : p.provider === "openai" ? "classification only; never invents contact facts"
        : "not admitted to the independent SFP execution boundary",
    }))),
    waterfall:["serper","free_first_party_recrawl","outscraper","apollo"],
    note:"Outscraper/Apollo now execute through executeSfpPaidPersonAndIdentityDiscovery, extracted adapters admitted via provider-manifest.ts (Task #1999 C5) — not the CRO-03C generation/handoff pipeline. OpenAI remains classification-only, used by the pre-cohort bridge, never invoked from this waterfall.",
  };
}

/**
 * Task #1999 (C6/C7/C11): typed-gap-driven Apollo (named decision-maker) and
 * Outscraper (business identity) escalation for a frozen cohort. Runs after
 * the Serper domain-discovery stage. Every reservation/settlement reuses
 * reserveSfpProviderOperation/settleSfpProviderOperation exactly like the
 * Serper stage above (same cohort/stage-run authority and durable receipts), so
 * this never becomes a second, ungoverned paid-I/O path. A resolved gap
 * dimension stops ONLY that provider for that business — Apollo is skipped
 * only when a verified named decision-maker already exists (C4 reuse);
 * Outscraper is admitted only when the official-domain and business-identity
 * dimensions both remain open; a known domain stops that provider even when
 * phone/address/locality fields are still incomplete.
 * Paid results are written to sfp_paid_candidate_evidence (C3) and linked
 * from sfp_stage_items.paidCandidateEvidenceId, never into
 * free_discovery_candidates/cro03c_candidate_evidence.
 */
export async function executeSfpPaidPersonAndIdentityDiscovery(
  input: {
    cohortRunId?: string;
    programId?: string;
    idempotencyKey: string;
    actorId: string;
    maxBusinesses?: number;
    previewSnapshotHash?: string;
    /** Continuous discovery has already given Serper its own independent phase. */
    includeSerperDiscovery?: boolean;
    /** Providers that passed their own control, circuit, and credential preflight. */
    enabledProviders?: Array<"outscraper" | "apollo">;
  },
  deps: { fetchImpl?: typeof fetch } = {},
) {
  const maxBusinesses = Math.max(1, Math.min(25, Number(input.maxBusinesses ?? 10)));
  if(Boolean(input.programId)===Boolean(input.cohortRunId)) throw new Error("SFP_DISCOVERY_SCOPE_REQUIRED");
  const programSelection=input.programId
    ? await programDiscoverySelection(input.programId,input.idempotencyKey,maxBusinesses,"paid"):null;
  let scopeHash:string;
  if(programSelection) scopeHash=sha256(programSelection.snapshot);
  else {
    if(!input.previewSnapshotHash) throw new Error("SFP_PREVIEW_REQUIRED");
    const currentPreview=await getSfpCohortGapSnapshot(input.cohortRunId!);
    if(currentPreview.snapshotHash!==input.previewSnapshotHash) throw new Error("SFP_STALE_PREVIEW");
    const cohortHashRow=rows(await db.execute(sql`SELECT cohort_hash FROM sfp_cohort_runs
      WHERE id=${input.cohortRunId!}::uuid`))[0];
    if(!cohortHashRow) throw new Error("SFP_COHORT_RUN_NOT_FOUND");
    scopeHash=cohortHashRow.cohort_hash;
  }
  const includeSerperDiscovery = input.includeSerperDiscovery !== false;
  const enabledProviders = new Set(input.enabledProviders ?? ["outscraper", "apollo"]);
  let apolloUnavailableReason: string | null = null;
  const providers = [
    ...(includeSerperDiscovery ? ["serper"] : []),
    ...(enabledProviders.has("outscraper") ? ["outscraper"] : []),
    ...(enabledProviders.has("apollo") ? ["apollo"] : []),
  ];
  const order = includeSerperDiscovery
    ? ["serper", "free_first_party_recrawl", ...providers.slice(1)]
    : [...providers];
  const payloadHash = sha256({
    cohortRunId: input.cohortRunId, programId:input.programId, cohortHash: scopeHash, maxBusinesses,
    providers,
    order,
    previewSnapshotHash: input.previewSnapshotHash ?? null,
  });
  const existing = rows(await db.execute(sql`
    SELECT * FROM sfp_stage_runs WHERE stage='paid_waterfall' AND idempotency_key=${input.idempotencyKey} LIMIT 1
  `))[0];
  if (existing?.payload_hash && String(existing.payload_hash) !== payloadHash) {
    throw new Error("SFP_IDEMPOTENCY_PAYLOAD_MISMATCH");
  }
  if (existing?.state === "completed") {
    return { stageRunId: String(existing.id), replayed: true, processed: Number(existing.processed_count), succeeded: Number(existing.succeeded_count), failed: Number(existing.failed_count), providerRequests: 0 };
  }
  const stage = existing ?? rows(await db.execute(sql`
    INSERT INTO sfp_stage_runs(cohort_run_id,program_id,selection_snapshot,stage,idempotency_key,actor_id,state,max_items,provider_keys,payload_hash,preview_snapshot_hash,started_at,last_heartbeat_at)
    VALUES(${input.cohortRunId ?? null}::uuid,${input.programId ?? null}::uuid,
      ${programSelection?JSON.stringify(programSelection.snapshot):null}::jsonb,
      'paid_waterfall',${input.idempotencyKey},${input.actorId},'authorized',${maxBusinesses},${JSON.stringify(providers)}::jsonb,${payloadHash},${input.previewSnapshotHash ?? null},NOW(),NOW())
    ON CONFLICT(stage,idempotency_key) DO UPDATE SET updated_at=NOW() RETURNING *
  `))[0];
  const stageClaimToken = await claimStageRun(String(stage.id));
  // Serper is a separate discovery phase in the recurring worker. Never let
  // a Serper circuit or credential gate independent providers.
  let serperProviderRequests = 0;
  if (includeSerperDiscovery) {
    const serperResult = await executeSfpSerperDiscovery({
      cohortRunId: input.cohortRunId,
      programId: input.programId,
      idempotencyKey: `${input.idempotencyKey}:serper`,
      actorId: input.actorId,
      maxBusinesses,
      previewSnapshotHash: input.previewSnapshotHash,
      internalSkipPreviewCheck: true,
    });
    serperProviderRequests = Number(serperResult.providerRequests ?? 0);
  }
  const completedTaskRuns: Array<Awaited<ReturnType<typeof processSfpOutscraperRetrievalTask>>> = [];
  if (enabledProviders.has("outscraper")) {
    const dueTasks = rows(await db.execute(sql`
      SELECT id
        FROM sfp_provider_retrieval_tasks
       WHERE state IN ('submitted','polling')
         AND (expires_at<=NOW() OR results_expires_at<=NOW()
              OR (next_poll_at<=NOW() AND
                  (state='submitted' OR (state='polling' AND lease_expires_at<=NOW()))))
       ORDER BY expires_at ASC,next_poll_at ASC,submitted_at ASC
       LIMIT ${maxBusinesses}
    `));
    for (const dueTask of dueTasks) {
      const taskRun = await processSfpOutscraperRetrievalTask({
        taskId: String(dueTask.id),
        fetchImpl: deps.fetchImpl,
      });
      completedTaskRuns.push(taskRun);
    }
  }
  const targets = programSelection?.targets ?? rows(await db.execute(sql`
    SELECT b.id,b.canonical_name,b.city,b.state,b.postal_code,b.street_address,b.website_domain,b.main_phone,m.roi_score
      FROM sfp_cohort_members m JOIN businesses b ON b.id=m.business_id
     WHERE m.cohort_run_id=${input.cohortRunId ?? null}::uuid
       AND b.record_class='canonical'
       AND NOT EXISTS (SELECT 1 FROM sfp_identity_quarantines q WHERE q.business_id=b.id AND q.cleared_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM sfp_cohort_decisions d WHERE d.cohort_run_id=m.cohort_run_id
                        AND d.business_id=b.id AND d.suppression_business_wide_rule_applied=TRUE)
       AND (
         (
           ${enabledProviders.has("outscraper")}
           AND b.website_domain IS NULL
           AND (NULLIF(BTRIM(b.main_phone),'') IS NULL OR NULLIF(BTRIM(b.street_address),'') IS NULL OR NULLIF(BTRIM(b.city),'') IS NULL)
           AND NOT EXISTS (
             SELECT 1 FROM provider_operations po
              WHERE po.provider='outscraper' AND po.purpose='sfp_business_identity_discovery'
                AND po.target_fingerprint = ('business:' || b.id::text)
                 AND (po.state IN ('pending','deferred','running') OR po.billing_state='reserved')
            )
            AND NOT EXISTS (
              SELECT 1 FROM sfp_provider_retrieval_tasks task
               WHERE task.provider='outscraper' AND task.cohort_run_id=m.cohort_run_id
                 AND task.business_id=b.id AND task.task_kind='maps_search'
                 AND task.state IN ('submitted','polling') AND task.expires_at>NOW()
           )
            AND NOT EXISTS (
              SELECT 1 FROM sfp_provider_retrieval_tasks task
               WHERE task.provider='outscraper' AND task.business_id=b.id AND task.task_kind='maps_search'
                 AND task.state IN ('completed','no_result') AND task.completed_at>=NOW()-INTERVAL '24 hours'
            )
            AND NOT EXISTS (
              SELECT 1 FROM sfp_provider_retrieval_tasks task
               WHERE task.provider='outscraper' AND task.business_id=b.id AND task.task_kind='maps_search'
                 AND task.state='failed' AND task.updated_at>=NOW()-INTERVAL '15 minutes'
            )
           AND NOT EXISTS (
             SELECT 1 FROM provider_operations po
              WHERE po.provider='outscraper' AND po.purpose='sfp_business_identity_discovery'
                AND po.target_fingerprint = ('business:' || b.id::text)
                AND po.state='completed' AND po.created_at >= NOW()-INTERVAL '24 hours'
           )
           AND NOT EXISTS (
             SELECT 1 FROM provider_operations po
              WHERE po.provider='outscraper' AND po.purpose='sfp_business_identity_discovery'
                AND po.target_fingerprint = ('business:' || b.id::text)
                AND po.state='failed' AND po.created_at >= NOW()-INTERVAL '15 minutes'
           )
           AND (SELECT COUNT(*) FROM provider_operations po
                 WHERE po.provider='outscraper' AND po.purpose='sfp_business_identity_discovery'
                   AND po.target_fingerprint = ('business:' || b.id::text)
                   AND po.state='failed' AND po.created_at >= NOW()-INTERVAL '24 hours') < 3
         )
         OR
         (
           ${enabledProviders.has("apollo")}
           AND NOT EXISTS (
             SELECT 1 FROM sfp_paid_candidate_evidence e WHERE e.business_id=b.id AND e.provider='apollo'
               AND e.subject_type='person' AND NULLIF(BTRIM(e.person_name_evidence),'') IS NOT NULL
               AND NULLIF(BTRIM(e.person_title_evidence),'') IS NOT NULL AND e.disposition IN ('staged','accepted')
           )
           AND NOT EXISTS (
             SELECT 1 FROM contact_business_link_decisions d JOIN contacts c ON c.id=d.contact_id
              WHERE d.business_id=b.id AND d.decision='verified' AND d.superseded_at IS NULL
                AND c.business_id=d.business_id
                AND NULLIF(BTRIM(CONCAT_WS(' ',NULLIF(c.first_name,''),NULLIF(c.last_name,''))),'') IS NOT NULL
                AND NULLIF(BTRIM(c.title),'') IS NOT NULL
           )
           AND NOT EXISTS (
             SELECT 1 FROM provider_operations po
              WHERE po.provider='apollo' AND po.purpose='sfp_named_decision_maker_discovery'
                AND po.target_fingerprint = ('business:' || b.id::text)
                 AND (po.state IN ('pending','deferred','running') OR po.billing_state='reserved')
           )
           AND NOT EXISTS (
             SELECT 1 FROM provider_operations po
              WHERE po.provider='apollo' AND po.purpose='sfp_named_decision_maker_discovery'
                AND po.target_fingerprint = ('business:' || b.id::text)
                AND po.state='completed' AND po.created_at >= NOW()-INTERVAL '24 hours'
           )
           AND NOT EXISTS (
             SELECT 1 FROM provider_operations po
              WHERE po.provider='apollo' AND po.purpose='sfp_named_decision_maker_discovery'
                AND po.target_fingerprint = ('business:' || b.id::text)
                AND po.state='failed' AND po.created_at >= NOW()-INTERVAL '15 minutes'
           )
           AND (SELECT COUNT(*) FROM provider_operations po
                 WHERE po.provider='apollo' AND po.purpose='sfp_named_decision_maker_discovery'
                   AND po.target_fingerprint = ('business:' || b.id::text)
                   AND po.state='failed' AND po.created_at >= NOW()-INTERVAL '24 hours') < 3
         )
       )
      ORDER BY COALESCE((
        SELECT MAX(i.completed_at) FROM sfp_stage_items i
        JOIN sfp_stage_runs prior ON prior.id=i.stage_run_id
        WHERE prior.cohort_run_id=m.cohort_run_id AND i.business_id=b.id
          AND i.provider='gap_vector'
      ),TIMESTAMPTZ 'epoch') ASC,m.roi_score DESC,b.id ASC
      LIMIT ${maxBusinesses}
  `));
  await db.execute(sql`UPDATE sfp_stage_runs SET selected_count=${targets.length},updated_at=NOW() WHERE id=${String(stage.id)}::uuid`);

  const businessIds = targets.map((t: any) => Number(t.id));
  const reuse = await computeContactLinkReuse(businessIds);
  let succeeded = 0, failed = 0, skipped = 0, pendingTasks = 0;
  let providerRequests = serperProviderRequests +
    completedTaskRuns.reduce((count, taskRun) => count + taskRun.providerRequests, 0);
  const gapVectors: Array<Awaited<ReturnType<typeof computeSfpGapVector>>> = [];

  for (const target of targets) {
    await renewStageRunClaim(String(stage.id), stageClaimToken);
    const businessId = Number(target.id);
    const linkReuse = reuse.get(businessId) ?? { hasVerifiedContact: false, hasVerifiedNamedDecisionMaker: false, verifiedLinks: [], skipReason: null };
    const beforeVector = await buildCurrentGapVector({
      cohortRunId: input.cohortRunId, geography:target.geography, businessId, reuse: linkReuse,
    });
    const gapOpen = (dimension: string) => beforeVector.before.some((entry) => entry.dimension === dimension && entry.open);
    let apolloSkipReason: string | null = !enabledProviders.has("apollo")
      ? (apolloUnavailableReason ?? "apollo_provider_not_ready")
      : gapOpen("named_decision_maker") ? null : (linkReuse.skipReason ?? "named_decision_maker_gap_closed");
    let outscraperSkipReason: string | null = !enabledProviders.has("outscraper")
      ? "outscraper_provider_not_ready"
      : !gapOpen("official_domain") ? "official_domain_gap_closed"
        : gapOpen("business_identity") ? null : "business_identity_gap_closed";

    // Outscraper follows Serper plus the canonical free recrawl, and requires
    // both the official-domain and business-identity dimensions to remain open.
    if (!outscraperSkipReason) {
      let reservation: Awaited<ReturnType<typeof reserveSfpProviderOperation>> | null = null;
      try {
        const activeTask = rows(await db.execute(sql`
          SELECT id FROM sfp_provider_retrieval_tasks
           WHERE provider='outscraper' AND cohort_run_id IS NOT DISTINCT FROM ${input.cohortRunId ?? null}::uuid
             AND business_id=${businessId} AND task_kind='maps_search'
             AND state IN ('submitted','polling') AND expires_at>NOW()
           LIMIT 1
        `))[0];
        if (activeTask) {
          skipped++;
          outscraperSkipReason = "outscraper_task_pending";
        } else {
        const priorExpired = Number(rows(await db.execute(sql`
          SELECT COUNT(*)::int AS count FROM sfp_provider_retrieval_tasks
           WHERE provider='outscraper' AND cohort_run_id IS NOT DISTINCT FROM ${input.cohortRunId ?? null}::uuid
             AND business_id=${businessId} AND task_kind='maps_search'
             AND state IN ('expired','failed')
        `))[0]?.count ?? 0);
        const retrySuffix = priorExpired ? `:retry:${priorExpired}` : "";
        reservation = await reserveSfpProviderOperation({
          stageRunId: String(stage.id), cohortRunId: input.cohortRunId, businessId,
          programId:input.programId,
          provider: "outscraper", purpose: "sfp_business_identity_discovery",
          idempotencyKey: `${input.idempotencyKey}:outscraper:${businessId}${retrySuffix}`,
          actorId: input.actorId, workUnit: "result", units: 2,
        });
        if (reservation.replayed) {
          skipped++;
          outscraperSkipReason = "outscraper_already_completed";
        } else {
          providerRequests++;
          const frozenRequest = {
            businessId,
            businessName: String(target.canonical_name),
            domain: canonicalDomain(target.website_domain),
            city: normalizedIdentity(target.city),
            state: normalizedIdentity(target.state),
            resultLimit: 2,
          };
          const requestFingerprint = sha256(frozenRequest);
          let persistedTaskId: string | null = null;
          const result = await invokeSfpProviderTransport(reservation, () =>
            executeSfpOutscraperDiscovery({
              businessId,
              businessName: frozenRequest.businessName,
              domain: frozenRequest.domain,
              city: frozenRequest.city,
              state: frozenRequest.state,
              resultLimit: frozenRequest.resultLimit,
              async: true,
            }, {
              ...deps,
              beforeRequest: () => assertCurrentSfpProviderReservation(reservation!),
              onTaskSubmitted: async (task) => {
                await persistOutscraperTaskSubmission({
                  task,
                  requestFingerprint,
                  businessId,
                  businessName: frozenRequest.businessName,
                  domain: frozenRequest.domain,
                  city: frozenRequest.city,
                  state: frozenRequest.state,
                  stageRunId: String(stage.id),
                  cohortRunId: input.cohortRunId,
                  reservation: reservation!,
                });
                persistedTaskId = task.requestId;
              },
            }));
          if (result.task?.requestId && result.task.state !== "failed") {
            if (persistedTaskId !== result.task.requestId) throw new Error("OUTSCRAPER_TASK_SUBMISSION_NOT_DURABLE");
            pendingTasks++;
            outscraperSkipReason = "outscraper_task_pending";
          } else if (!result.ok || result.task?.state === "failed") {
            await finishSfpOperation({
              reservation, outcome: "ambiguous", observation: "transport", businessId, workCompleted: 0,
              providerUsage: providerUsage("unknown", "result", undefined, result.billing?.providerReference, "outscraper_submission"),
              resultData: { retrievalState: "submission_failed" },
            });
            failed++;
            outscraperSkipReason = "outscraper_submission_failed";
          } else {
            const usage = result.billing?.certainty === "exact" && result.billing.quantity !== undefined
              ? providerUsage("known", result.billing.unit, result.billing.quantity, result.billing.providerReference, "outscraper_maps_result_count")
              : providerUsage("unknown", result.billing?.unit ?? "result", undefined, result.billing?.providerReference, "outscraper_maps_result_count");
            const matches = result.results.filter((place) => outscraperMatchesPinnedBusiness(place, target));
            const place = matches.length === 1 ? matches[0] : null;
            const candidateValues = place ? businessCandidateValues(place) : [];
            const namedContacts = place ? namedOutscraperEmailCandidates(place) : [];
            const actualWork = result.consideredResultCount;
            if (place && candidateValues.length) {
              const domain = canonicalDomain(place.website);
              const evidence = await db.transaction(async (tx) => {
                const written = [];
                for (const item of candidateValues) {
                  written.push(await writeSfpPaidCandidateEvidence({
                    businessId, provider: "outscraper", field: item.field, value: item.value, subjectType: "business",
                    providerOperationId: reservation!.operationId, confidence: 70,
                    candidateMetadata: { source: "outscraper", placeId: place.placeId ?? null },
                  }, tx));
                }
                for (const contact of namedContacts) {
                  written.push(await writeSfpPaidCandidateEvidence({
                    businessId, provider: "outscraper", field: "email", value: contact.email, subjectType: "person",
                    providerOperationId: reservation!.operationId, confidence: 65,
                    personNameEvidence: contact.name, personTitleEvidence: contact.title,
                    candidateMetadata: { source: "outscraper_leads_contacts" },
                  }, tx));
                }
                await tx.execute(sql`
                  UPDATE businesses SET
                    website_domain=COALESCE(website_domain,${domain}),
                    main_phone=COALESCE(main_phone,${place.phone ?? null}),
                    street_address=COALESCE(street_address,${place.address ?? null}),
                    city=COALESCE(city,${place.city ?? null}),
                    state=COALESCE(state,${place.state ?? null}),
                    postal_code=COALESCE(postal_code,${place.zip ?? null}),
                    updated_at=NOW()
                  WHERE id=${businessId}
                `);
                await finishSfpOperation({
                  reservation: reservation!, outcome: "completed", observation: "valid", businessId,
                  workCompleted: actualWork, providerUsage: usage,
                  resultData: { retrievalState: matches.length > 1 ? "identity_ambiguous" : "completed" },
                }, tx);
                await tx.execute(sql`
                  UPDATE sfp_stage_items
                     SET paid_candidate_evidence_id=${written[0].id}::uuid,outcome_code='candidate_found',updated_at=NOW()
                   WHERE provider_operation_id=${reservation!.operationId}::uuid
                `);
                return written;
              });
              void evidence;
              succeeded++;
            } else {
              await finishSfpOperation({
                reservation, outcome: "no_result", observation: matches.length > 1 ? "unknown" : "no_result", businessId,
                workCompleted: result.consideredResultCount, providerUsage: usage,
                resultData: { retrievalState: matches.length > 1 ? "identity_ambiguous" : "no_match" },
              });
              skipped++;
              if (matches.length > 1) outscraperSkipReason = "outscraper_identity_ambiguous";
            }
          }
        }
        }
      } catch (error: any) {
        if (reservation) await finishSfpOperation({
          reservation, outcome: "failed", observation: "transport", businessId, workCompleted: 0,
          providerUsage: providerUsage("unknown", "result", undefined, null, "outscraper_transport"),
        }).catch(() => {});
        failed++;
        outscraperSkipReason = `outscraper_failed:${String(error?.message ?? error).slice(0, 120)}`;
      }
    } else {
      skipped++;
    }

    if (!apolloSkipReason) {
      try {
        const apolloAttemptCounts = new Map<string, number>();
        const apolloAttemptOperationIds = new Map<string, string[]>();
        const apolloAmbiguousOperationIds = new Map<string, string[]>();
        const dispatchApolloRequest = async (
          url: string,
          init: RequestInit,
          employerScope?: ApolloEmployerScope,
        ) => {
          if (!enabledProviders.has("apollo")) {
            throw new Error("SFP_APOLLO_PROVIDER_UNAVAILABLE");
          }
          const requestBody = typeof init.body === "string" ? init.body : "";
          let requestBodyValue: unknown = requestBody;
          try { requestBodyValue = JSON.parse(requestBody); } catch { /* retain only hashed payload below */ }
          const urlPath = new URL(url).pathname;
          const requestBodyRecord = requestBodyValue && typeof requestBodyValue === "object" &&
            !Array.isArray(requestBodyValue) ? requestBodyValue as Record<string, any> : {};
          const organizationSearch = urlPath.endsWith("/mixed_companies/search");
          const bulkEnrichment = urlPath.endsWith("/people/bulk_match");
          const reservedWork = calculateApolloRequestWork({
            endpointPath: urlPath,
            requestBody: requestBodyRecord,
            requestSucceeded: false,
            employerScope,
          });
          const workUnit = reservedWork.workUnit;
          const units = reservedWork.reservedUnits;
          const requestFingerprint = sha256({
            url,
            method: init.method ?? "POST",
            body: requestBodyValue,
            employerScope: employerScope ?? null,
          });
          const attemptNumber = (apolloAttemptCounts.get(requestFingerprint) ?? 0) + 1;
          apolloAttemptCounts.set(requestFingerprint, attemptNumber);
          const requestIdempotencyKey = `sfp-apollo-request:${businessId}:${sha256({
            parentKey: input.idempotencyKey,
            requestFingerprint,
            attemptNumber,
          })}`;
          const requestStage = await beginSfpApolloRequestStageRun({
            parentStageRunId: String(stage.id),
            cohortRunId: input.cohortRunId,
            programId: input.programId,
            businessId,
            actorId: input.actorId,
            idempotencyKey: requestIdempotencyKey,
            requestFingerprint,
          });
          if (requestStage.replayed || !requestStage.claimToken) {
            throw new Error("SFP_APOLLO_REQUEST_REPLAY_RESULT_UNAVAILABLE");
          }
          let requestReservation: SfpProviderReservation | null = null;
          let requestDispatched = false;
          let requestWorkCompleted = 0;
          let requestSettled = false;
          let requestUsage = providerUsage("unknown", "credit", undefined, null, "apollo_transport");
          try {
            requestReservation = await reserveSfpProviderOperation({
              stageRunId: requestStage.id,
              cohortRunId: input.cohortRunId,
              programId: input.programId,
              businessId,
              provider: "apollo",
              purpose: "sfp_named_decision_maker_discovery",
              idempotencyKey: requestIdempotencyKey,
              actorId: input.actorId,
              workUnit,
              units,
            });
            if (requestReservation.replayed) {
              await finishSfpApolloRequestStageRun(requestStage.id, requestStage.claimToken, "partial");
              throw new Error("SFP_APOLLO_REQUEST_REPLAY_RESULT_UNAVAILABLE");
            }
            const operationIds = apolloAttemptOperationIds.get(requestFingerprint) ?? [];
            if (!operationIds.includes(requestReservation.operationId)) {
              operationIds.push(requestReservation.operationId);
            }
            apolloAttemptOperationIds.set(requestFingerprint, operationIds);
            const response = await invokeSfpProviderTransport(requestReservation, () => {
              requestDispatched = true;
              providerRequests++;
              return (deps.fetchImpl ?? fetch)(url, init);
            });
            let body: Record<string, unknown> = {};
            try {
              const parsed = await response.clone().json();
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                body = parsed as Record<string, unknown>;
              }
            } catch {
              // A malformed response remains explicit unknown usage below.
            }
            const receipt = parseApolloUsageReceipt(response.headers, body);
            const explicitReceipt = [
              "x-apollo-credits-used", "x-credits-used", "x-credit-cost",
            ].some((header) => response.headers.get(header) !== null) ||
              ["credits_consumed", "credits_used", "creditsUsed", "credit_cost", "creditCost"]
                .some((key) => body[key] !== undefined);
            const errorMessage = body.error ?? body.error_message ?? body.message;
            const requestSucceeded = response.ok &&
              !(typeof errorMessage === "string" && errorMessage.trim());
            if (!requestSucceeded) {
              const unavailable = sfpUnavailableHttpReason("apollo", response.status);
              if (unavailable) {
                // Complete/settle this rejected request normally, but do not
                // try Apollo again for every other business in this batch.
                // Other providers and subsequent validation stay independent.
                apolloUnavailableReason = unavailable;
                apolloSkipReason = unavailable;
                enabledProviders.delete("apollo");
              }
            }
            const documentedSearchCredits = documentedApolloSearchCredits(urlPath);
            const contradictsDocumentedSearchCost = !bulkEnrichment &&
              documentedSearchCredits !== null && receipt.certainty === "exact" &&
              receipt.quantity !== undefined && receipt.quantity !== documentedSearchCredits;
            const usage = contradictsDocumentedSearchCost
              ? providerUsage("conflict", "credit", undefined, receipt.providerReference,
                "apollo_receipt_conflicts_with_documented_search_cost")
              : receipt.certainty === "exact" && receipt.quantity !== undefined
              ? providerUsage("known", "credit", receipt.quantity, receipt.providerReference, bulkEnrichment
                ? "apollo_bulk_business_email_enrichment"
                : "apollo_search_receipt")
              : requestSucceeded && !bulkEnrichment && !explicitReceipt && documentedSearchCredits !== null
                ? providerUsage("known", "credit", documentedSearchCredits, receipt.providerReference,
                  organizationSearch
                    ? "apollo_organization_search_documented_one_per_page"
                    : "apollo_people_api_search_documented_zero")
                : providerUsage(explicitReceipt ? "conflict" : "unknown", "credit", undefined,
                  receipt.providerReference, bulkEnrichment
                    ? "apollo_bulk_business_email_enrichment"
                    : "apollo_search_receipt");
            requestUsage = usage;
            const completedWork = calculateApolloRequestWork({
              endpointPath: urlPath,
              requestBody: requestBodyRecord,
              responseBody: body,
              requestSucceeded,
              employerScope,
            });
            const workCompleted = completedWork.completedUnits;
            requestWorkCompleted = workCompleted;
            if (workCompleted > requestReservation.units) {
              await finishSfpOperation({
                reservation: requestReservation,
                outcome: "completed",
                observation: "invalid",
                businessId,
                workCompleted: 0,
                providerUsage: usage,
                resultData: { retrievalState: "result_limit_exceeded", providerReference: usage.providerRequestId },
              });
              requestSettled = true;
              await finishSfpApolloRequestStageRun(requestStage.id, requestStage.claimToken, "partial");
              throw new Error("APOLLO_RESULT_LIMIT_EXCEEDED");
            }
            await finishSfpOperation({
              reservation: requestReservation,
              outcome: !requestSucceeded ? "failed" : workCompleted ? "completed" : "no_result",
              observation: !requestSucceeded ? "transport" : workCompleted ? "valid" : "no_result",
              businessId,
              workCompleted,
              providerUsage: usage,
              resultData: {
                retrievalState: requestSucceeded ? "completed" : "failed",
                providerReference: usage.providerRequestId,
                ...buildSfpProviderHttpDiagnostics(response.status, !requestSucceeded,
                  organizationSearch ? "organization_search" : bulkEnrichment ? "business_email_enrichment" : "people_search"),
              },
            });
            requestSettled = true;
            await finishSfpApolloRequestStageRun(
              requestStage.id,
              requestStage.claimToken,
              requestSucceeded ? "completed" : "partial",
            );
            return {
              response,
              operationId: requestReservation.operationId,
              operationIds: [...operationIds],
              ambiguousOperationIds: apolloAmbiguousOperationIds.get(requestFingerprint) ?? [],
            };
          } catch (error) {
            if (requestReservation && !requestSettled) {
              await finishSfpOperation({
                reservation: requestReservation,
                outcome: "ambiguous",
                observation: "transport",
                businessId,
                workCompleted: organizationSearch && requestDispatched ? 1 : requestWorkCompleted,
                providerUsage: requestUsage,
                resultData: { retrievalState: "ambiguous" },
              }).catch(() => {});
            }
            if (requestReservation && requestDispatched && !requestSettled) {
              const ambiguousIds = apolloAmbiguousOperationIds.get(requestFingerprint) ?? [];
              if (!ambiguousIds.includes(requestReservation.operationId)) {
                ambiguousIds.push(requestReservation.operationId);
              }
              apolloAmbiguousOperationIds.set(requestFingerprint, ambiguousIds);
            }
            if (requestStage.claimToken) {
              await finishSfpApolloRequestStageRun(requestStage.id, requestStage.claimToken, "partial")
                .catch(() => {});
            }
            if (error instanceof Error) {
              (error as Error & { apolloOperationIds?: readonly string[] }).apolloOperationIds =
                apolloAttemptOperationIds.get(requestFingerprint) ?? [];
              (error as Error & { apolloAmbiguousOperationIds?: readonly string[] }).apolloAmbiguousOperationIds =
                apolloAmbiguousOperationIds.get(requestFingerprint) ?? [];
            }
            throw error;
          }
        };
        const result = await executeSfpApolloDiscovery({
            businessId, businessName: String(target.canonical_name), domain: target.website_domain,
            city: target.city, state: target.state, address: target.street_address, resultCap: 10,
          }, {
            ...deps,
            dispatchApolloRequest,
          });
        const people = result.outcome === "success" ? [...result.people] : [];
        people.sort((a: any, b: any) => {
          const tierA = candidateTier({ subject_type: "person", stage_key: "apollo",
            apollo_match_confidence: "high", candidate_metadata: { ownerTitle: a.ownerTitle } });
          const tierB = candidateTier({ subject_type: "person", stage_key: "apollo",
            apollo_match_confidence: "high", candidate_metadata: { ownerTitle: b.ownerTitle } });
          return tierA - tierB || Number(Boolean(b.ownerEmail ?? b.email)) - Number(Boolean(a.ownerEmail ?? a.email));
        });
        const candidateValues: Array<{
          field: string;
          value: string;
          subjectType: "person" | "business";
          personName?: string | null;
          personTitle?: string | null;
          operationId: string | null;
        }> = [];
        const org: any = result.outcome === "success" ? result.organization : null;
        const organizationOperationId = result.outcome === "success"
          ? result.organizationOperationId : null;
        if (org) {
          for (const [field, value] of [["phone", org.phone], ["email", org.email], ["website", org.website],
            ["address", org.address], ["city", org.city], ["state", org.state], ["zip", org.zip], ["category", org.category]] as const) {
            if (typeof value === "string" && value.trim() &&
                (field !== "email" || !rejectEmailCandidate(value, "business"))) {
              candidateValues.push({
                field, value: value.trim(), subjectType: "business",
                operationId: organizationOperationId ?? null,
              });
            }
          }
        }
        for (const person of people as any[]) {
          const name = [person.ownerFirstName, person.ownerLastName].filter(Boolean).join(" ") || person.name || null;
          const personOperationId = person.personOperationId ?? null;
          const emailEnrichmentOperationId = person.emailEnrichmentOperationId ?? null;
          if (typeof name === "string" && name.trim()) {
            candidateValues.push({
              field: "owner_name", value: name.trim(), subjectType: "person",
              personName: name.trim(), personTitle: person.ownerTitle ?? null,
              operationId: personOperationId,
            });
          }
          if (typeof person.ownerTitle === "string" && person.ownerTitle.trim()) {
            candidateValues.push({
              field: "owner_title", value: person.ownerTitle.trim(), subjectType: "person",
              personName: name, personTitle: person.ownerTitle.trim(),
              operationId: personOperationId,
            });
          }
          for (const [field, value] of [["email", person.ownerEmail ?? person.email], ["phone", person.ownerPhone ?? person.phone]] as const) {
            if (typeof value !== "string" || !value.trim()) continue;
            if (field === "email" && rejectEmailCandidate(value, "person")) continue;
            candidateValues.push({
              field, value: value.trim(), subjectType: "person",
              personName: name, personTitle: person.ownerTitle ?? null,
              operationId: field === "email" ? emailEnrichmentOperationId : personOperationId,
            });
          }
        }
        if (result.outcome === "success" && candidateValues.length) {
          if (candidateValues.some((item) => !item.operationId)) {
            throw new Error("APOLLO_CANDIDATE_REQUEST_ATTRIBUTION_MISSING");
          }
          const writes = await db.transaction(async (tx) => {
            const evidence = [];
            for (const [index, item] of candidateValues.entries()) {
              const written = await writeSfpPaidCandidateEvidence({
                businessId, provider: "apollo", field: item.field, value: item.value, subjectType: item.subjectType,
                providerOperationId: item.operationId!, confidence: 75,
                personNameEvidence: item.personName ?? null, personTitleEvidence: item.personTitle ?? null,
                candidateMetadata: item.subjectType === "person"
                  ? {
                    apolloMatchConfidence: "high", ownerTitle: item.personTitle ?? null,
                    requestOperationId: item.operationId,
                  }
                  : {
                    source: "apollo", organizationId: result.organizationId,
                    requestOperationId: item.operationId,
                  },
              }, tx);
              evidence.push(written);
              await tx.execute(sql`
                UPDATE sfp_stage_items
                   SET paid_candidate_evidence_id=COALESCE(paid_candidate_evidence_id,${written.id}::uuid),
                       outcome_code='candidate_found',updated_at=NOW()
                 WHERE provider_operation_id=${item.operationId}::uuid
              `);
            }
            await tx.execute(sql`
              UPDATE businesses SET
                website_domain=COALESCE(website_domain,${canonicalDomain(org?.website)}),
                main_phone=COALESCE(main_phone,${org?.phone ?? null}),
                street_address=COALESCE(street_address,${org?.address ?? null}),
                city=COALESCE(city,${org?.city ?? null}),
                state=COALESCE(state,${org?.state ?? null}),
                postal_code=COALESCE(postal_code,${org?.zip ?? null}),
                updated_at=NOW()
              WHERE id=${businessId}
            `);
            return evidence;
          });
          void writes;
          succeeded++;
        } else {
          skipped++;
        }
      } catch (error: any) {
        failed++;
        apolloSkipReason = apolloUnavailableReason ??
          `apollo_failed:${String(error?.message ?? error).slice(0, 120)}`;
      }
    } else {
      skipped++;
    }

    const afterVector = await buildCurrentGapVector({
      cohortRunId: input.cohortRunId, geography:target.geography, businessId, reuse: linkReuse,
      apolloSkipReason, outscraperSkipReason,
    });
    const completeVector = { ...afterVector, before: beforeVector.before };
    gapVectors.push(completeVector);
    await db.execute(sql`
      INSERT INTO sfp_stage_items(stage_run_id,business_id,provider,state,outcome_code,gap_vector,redacted_result,completed_at)
      VALUES(${String(stage.id)}::uuid,${businessId},'gap_vector','completed','gap_vector_recorded',
             ${JSON.stringify(completeVector)}::jsonb,${JSON.stringify({ before: completeVector.before, after: completeVector.after })}::jsonb,NOW())
      ON CONFLICT(stage_run_id,business_id,provider) DO UPDATE
        SET gap_vector=EXCLUDED.gap_vector,redacted_result=EXCLUDED.redacted_result,updated_at=NOW()
    `);
  }

  pendingTasks = Number(rows(await db.execute(sql`
    SELECT COUNT(*)::int AS count
      FROM sfp_provider_retrieval_tasks
     WHERE cohort_run_id IS NOT DISTINCT FROM ${input.cohortRunId ?? null}::uuid AND state IN ('submitted','polling')
  `))[0]?.count ?? 0);
  await db.execute(sql`
    UPDATE sfp_stage_runs SET state=${failed || pendingTasks ? "partial" : "completed"},claim_token=NULL,lease_expires_at=NULL,processed_count=${targets.length},
           succeeded_count=${succeeded},failed_count=${failed},skipped_count=${skipped},
           completed_at=NOW(),last_heartbeat_at=NOW(),updated_at=NOW()
     WHERE id=${String(stage.id)}::uuid AND claim_token=${stageClaimToken}::uuid
  `);
  return {
    stageRunId: String(stage.id), replayed: false, processed: targets.length, succeeded, failed, skipped,
    pendingTasks, providerRequests,
    gapVectors: gapVectors.map((v) => ({
      businessId: v.businessId, before: v.before, after: v.after,
      stopConditions: stopConditionsMet(v), skippedProviderCalls: v.skippedProviderCalls,
    })),
    taskRuns: completedTaskRuns,
    zeroOutreachConfirmed: true,
  };
}

async function beginOutscraperTaskStageRun(
  task: any,
  idempotencyKey: string,
  actorId: string,
): Promise<{ id: string; claimToken: string }> {
  const originalStage = rows(await db.execute(sql`
    SELECT preview_snapshot_hash,program_id,selection_snapshot FROM sfp_stage_runs WHERE id=${String(task.stage_run_id)}::uuid
  `))[0];
  const payloadHash = sha256({
    taskId: String(task.id),
    providerTaskId: String(task.provider_task_id),
    attempt: Number(task.attempt_count),
    phase: idempotencyKey.includes(":contacts:") ? "leads_and_contacts" : "poll",
  });
  const stage = rows(await db.execute(sql`
    INSERT INTO sfp_stage_runs
      (cohort_run_id,program_id,selection_snapshot,stage,idempotency_key,actor_id,state,max_items,provider_keys,payload_hash,
       preview_snapshot_hash,started_at,last_heartbeat_at)
    VALUES (${task.cohort_run_id ?? null}::uuid,${originalStage?.program_id ?? null}::uuid,
      ${originalStage?.selection_snapshot?JSON.stringify(originalStage.selection_snapshot):null}::jsonb,
      'paid_waterfall',${idempotencyKey},${actorId},
            'authorized',1,'["outscraper"]'::jsonb,${payloadHash},
            ${originalStage?.preview_snapshot_hash ?? null},NOW(),NOW())
    ON CONFLICT(stage,idempotency_key) DO UPDATE SET updated_at=NOW()
    RETURNING id
  `))[0];
  if (!stage?.id) throw new Error("SFP_OUTSCRAPER_TASK_STAGE_CREATE_FAILED");
  const id = String(stage.id);
  const claimToken = await claimStageRun(id);
  await db.execute(sql`
    UPDATE sfp_stage_runs SET selected_count=1,updated_at=NOW() WHERE id=${id}::uuid
  `);
  return { id, claimToken };
}

async function finishOutscraperTaskStageRun(
  stageRunId: string,
  claimToken: string,
  status: "completed" | "partial",
  failed: number,
): Promise<void> {
  await db.execute(sql`
    UPDATE sfp_stage_runs
       SET state=${status},claim_token=NULL,lease_expires_at=NULL,processed_count=1,
           succeeded_count=${status === "completed" && !failed ? 1 : 0},failed_count=${failed},
           skipped_count=0,completed_at=NOW(),last_heartbeat_at=NOW(),updated_at=NOW()
     WHERE id=${stageRunId}::uuid AND claim_token=${claimToken}::uuid
  `);
}

async function beginSfpApolloRequestStageRun(input: {
  parentStageRunId: string;
  cohortRunId?: string;
  programId?: string;
  businessId: number;
  actorId: string;
  idempotencyKey: string;
  requestFingerprint: string;
}): Promise<{ id: string; claimToken: string | null; replayed: boolean }> {
  const parent = rows(await db.execute(sql`
    SELECT preview_snapshot_hash,program_id,selection_snapshot FROM sfp_stage_runs WHERE id=${input.parentStageRunId}::uuid
  `))[0];
  const payloadHash = sha256({
    businessId: input.businessId,
    requestFingerprint: input.requestFingerprint,
    parentStageRunId: input.parentStageRunId,
  });
  const stage = rows(await db.execute(sql`
    INSERT INTO sfp_stage_runs
      (cohort_run_id,program_id,selection_snapshot,stage,idempotency_key,actor_id,state,max_items,provider_keys,payload_hash,
       preview_snapshot_hash,started_at,last_heartbeat_at)
    VALUES (${input.cohortRunId ?? null}::uuid,${parent?.program_id ?? null}::uuid,
      ${parent?.selection_snapshot?JSON.stringify(parent.selection_snapshot):null}::jsonb,
      'paid_waterfall',${input.idempotencyKey},${input.actorId},
            'authorized',1,'["apollo"]'::jsonb,${payloadHash},
            ${parent?.preview_snapshot_hash ?? null},NOW(),NOW())
    ON CONFLICT(stage,idempotency_key) DO UPDATE SET updated_at=NOW()
    RETURNING id,state,payload_hash
  `))[0];
  if (!stage?.id || String(stage.payload_hash) !== payloadHash) {
    throw new Error("SFP_APOLLO_REQUEST_STAGE_IDEMPOTENCY_MISMATCH");
  }
  if (String(stage.state) === "completed") {
    return { id: String(stage.id), claimToken: null, replayed: true };
  }
  const claimToken = await claimStageRun(String(stage.id));
  const selected = rows(await db.execute(sql`
    UPDATE sfp_stage_runs SET selected_count=1,updated_at=NOW()
     WHERE id=${String(stage.id)}::uuid AND claim_token=${claimToken}::uuid
    RETURNING id
  `))[0];
  if (!selected) throw new Error("SFP_APOLLO_REQUEST_STAGE_FENCE_LOST");
  return { id: String(stage.id), claimToken, replayed: false };
}

async function finishSfpApolloRequestStageRun(
  stageRunId: string,
  claimToken: string,
  outcome: "completed" | "partial",
): Promise<void> {
  await db.execute(sql`
    UPDATE sfp_stage_runs
       SET state=${outcome},claim_token=NULL,lease_expires_at=NULL,processed_count=1,
           succeeded_count=${outcome === "completed" ? 1 : 0},
           failed_count=${outcome === "partial" ? 1 : 0},skipped_count=0,
           completed_at=NOW(),last_heartbeat_at=NOW(),updated_at=NOW()
     WHERE id=${stageRunId}::uuid AND claim_token=${claimToken}::uuid
  `);
}

function originalOutscraperReservation(row: any): SfpProviderReservation {
  if (!row?.claim_token || String(row.submission_state) !== "running" || String(row.billing_state) !== "reserved") {
    throw new Error("OUTSCRAPER_ORIGINAL_OPERATION_NOT_SETTLEABLE");
  }
  return {
    operationId: String(row.operation_id),
    claimToken: String(row.claim_token),
    provider: "outscraper",
    controlProvider: String(row.control_provider),
    amountMicros: row.unit_price_micros == null ? null : Number(row.unit_price_micros),
    reviewedUnitPriceMicros: row.unit_price_micros == null ? null : Number(row.unit_price_micros),
    reviewedUnitType: row.unit_price_unit == null ? null : String(row.unit_price_unit),
    noResultBillable: row.no_result_billable == null ? null : Boolean(row.no_result_billable),
    workUnit: String(row.sfp_result_data?.reservedWorkUnit ?? "result"),
    units: Number(row.reserved_units),
    stageRunId: String(row.submission_stage_run_id),
    businessId:Number(row.business_id),
    cohortRunId:row.cohort_run_id ? String(row.cohort_run_id):undefined,
    programId:row.program_id ?? undefined,
    selectionHash:row.sfp_result_data?.reservedSelectionHash ?? undefined,
    runtimeOwnerEpoch: Number(row.runtime_owner_epoch ?? 0),
    runtimeOwnerToken: String(row.runtime_owner_token ?? ""),
  };
}

async function expireLeasedOutscraperTask(input: {
  taskId: string;
  leaseToken: string;
  task: any;
  errorCode: string;
}): Promise<boolean> {
  const expired = rows(await db.execute(sql`
    UPDATE sfp_provider_retrieval_tasks
       SET state='expired',lease_token=NULL,lease_expires_at=NULL,last_error_code=${input.errorCode},
           completed_at=NOW(),updated_at=NOW()
     WHERE id=${input.taskId}::uuid AND state='polling' AND lease_token=${input.leaseToken}::uuid
     RETURNING id
  `))[0];
  if (!expired) return false;
  try {
    await finishSfpOperation({
      reservation: originalOutscraperReservation(input.task),
      outcome: "ambiguous",
      observation: "unknown",
      businessId: Number(input.task.business_id),
      workCompleted: 0,
      providerUsage: providerUsage(
        "unknown", "result", undefined, String(input.task.provider_task_id), "outscraper_results_retention_bound",
      ),
      resultData: {
        retrievalState: "results_unavailable_at_conservative_deadline",
        providerReference: String(input.task.provider_task_id),
        externalTaskId: String(input.task.provider_task_id),
      },
    });
  } catch {
    // The terminal task CAS remains authoritative if a concurrent worker has
    // already settled the original submission operation.
  }
  await db.execute(sql`
    UPDATE sfp_stage_items
       SET state='failed',outcome_code='outscraper_results_retention_bound',
           redacted_result=${JSON.stringify({
             retrievalState: "results_unavailable_at_conservative_deadline",
             providerReference: String(input.task.provider_task_id),
           })}::jsonb,
           completed_at=NOW(),updated_at=NOW()
     WHERE provider_operation_id=${String(input.task.submission_operation_id)}::uuid
  `);
  return true;
}

/**
 * Restart-safe, fenced completion worker for an Outscraper Maps request.
 * Polling uses its own provider reservation; completed Maps result usage is
 * settled exactly once against the original submission operation and stable
 * provider task ID. The GET results endpoint adds no new Maps search results,
 * so its result-unit charge is exactly zero; all returned Maps results settle
 * on the original request, avoiding both double billing and free submissions.
 */
export async function processSfpOutscraperRetrievalTask(input: {
  taskId: string;
  actorId?: string;
  fetchImpl?: typeof fetch;
  recordCreditSignal?: (input: { httpStatus: number; message?: string | null; failure: boolean }) => Promise<void>;
}): Promise<{
  taskId: string;
  state: "pending" | "completed" | "no_result" | "failed" | "expired" | "deferred";
  providerRequests: number;
  resultCount?: number;
  contactCount?: number;
  errorCode?: string;
}> {
  if (!/^[0-9a-f-]{36}$/i.test(input.taskId)) throw new Error("SFP_OUTSCRAPER_TASK_ID_INVALID");
  let task = rows(await db.execute(sql`
    SELECT task.*,original_stage.program_id,submission.state AS submission_state,submission.billing_state,
           submission.claim_token,submission.reserved_units,submission.unit_price_micros,
           submission.unit_price_unit,submission.runtime_owner_epoch,submission.runtime_owner_token,
           submission.provider AS control_provider,submission.id AS operation_id,
           task.stage_run_id AS submission_stage_run_id,submission.sfp_result_data,
           submission.actor_id AS submission_actor_id,
           CASE WHEN submission.sfp_result_data->>'noResultBillable' IN ('true','false')
                THEN (submission.sfp_result_data->>'noResultBillable')::boolean ELSE NULL END AS no_result_billable
      FROM sfp_provider_retrieval_tasks task
      JOIN provider_operations submission ON submission.id=task.submission_operation_id
      JOIN sfp_stage_runs original_stage ON original_stage.id=task.stage_run_id
     WHERE task.id=${input.taskId}::uuid
  `))[0];
  if (!task) throw new Error("SFP_OUTSCRAPER_TASK_NOT_FOUND");
  const state = String(task.state);
  if (["completed", "no_result", "failed", "expired"].includes(state)) {
    return { taskId: input.taskId, state: state as "completed" | "no_result" | "failed" | "expired", providerRequests: 0 };
  }
   const submissionExpired = new Date(task.expires_at).getTime() <= Date.now();
    const resultsRetentionBoundReached = task.results_expires_at != null &&
     new Date(task.results_expires_at).getTime() <= Date.now();
    if (submissionExpired || resultsRetentionBoundReached) {
      const expiryCode = resultsRetentionBoundReached
        ? "OUTSCRAPER_RESULTS_CONSERVATIVE_BOUND_REACHED" : "OUTSCRAPER_TASK_EXPIRED";
    const expired = rows(await db.execute(sql`
      UPDATE sfp_provider_retrieval_tasks SET state='expired',lease_token=NULL,lease_expires_at=NULL,
              last_error_code=${expiryCode},completed_at=NOW(),updated_at=NOW()
        WHERE id=${input.taskId}::uuid AND state IN ('submitted','polling')
          AND (expires_at<=NOW() OR results_expires_at<=NOW())
       RETURNING id
    `))[0];
    if (!expired) return { taskId: input.taskId, state: "deferred", providerRequests: 0 };
    try {
      const reservation = originalOutscraperReservation(task);
      await finishSfpOperation({
        reservation, outcome: "ambiguous", observation: "unknown", businessId: Number(task.business_id),
        workCompleted: 0,
        providerUsage: providerUsage("unknown", "result", undefined, String(task.provider_task_id), "outscraper_task_expired"),
        resultData: { retrievalState: "expired", providerReference: String(task.provider_task_id), externalTaskId: String(task.provider_task_id) },
      });
    } catch {
      // A concurrent/late completion may already have settled the original
      // reservation. The task's terminal CAS is the source-of-truth fence.
    }
     return { taskId: input.taskId, state: "expired", providerRequests: 0, errorCode: expiryCode };
  }

  const leaseToken = randomUUID();
  const claimed = rows(await db.execute(sql`
    UPDATE sfp_provider_retrieval_tasks
       SET state='polling',lease_token=${leaseToken}::uuid,lease_expires_at=NOW()+INTERVAL '10 minutes',
           attempt_count=attempt_count+1,updated_at=NOW()
     WHERE id=${input.taskId}::uuid AND expires_at>NOW()
       AND (results_expires_at IS NULL OR results_expires_at>NOW())
       AND next_poll_at<=NOW()
       AND (state='submitted' OR (state='polling' AND lease_expires_at<=NOW()))
     RETURNING *
  `))[0];
  if (!claimed) {
    const current = rows(await db.execute(sql`
      SELECT state FROM sfp_provider_retrieval_tasks WHERE id=${input.taskId}::uuid
    `))[0];
    return {
      taskId: input.taskId,
      state: current && ["completed", "no_result", "failed", "expired"].includes(String(current.state))
        ? String(current.state) as "completed" | "no_result" | "failed" | "expired" : "deferred",
      providerRequests: 0,
    };
  }
  task = { ...task, ...claimed };
  const attempt = Number(task.attempt_count);
  const pollRun = await beginOutscraperTaskStageRun(
    task, `sfp-outs-task:${input.taskId}:poll:${attempt}`,
    input.actorId ?? String(task.submission_actor_id),
  );
  let pollReservation: SfpProviderReservation | null = null;
  try {
    pollReservation = await reserveSfpProviderOperation({
      stageRunId: pollRun.id,
      cohortRunId: task.cohort_run_id ? String(task.cohort_run_id):undefined,
      programId:task.program_id ?? undefined,
      businessId: Number(task.business_id),
      provider: "outscraper",
      purpose: "sfp_outscraper_task_poll",
      idempotencyKey: `sfp-outs-task:${input.taskId}:poll:${attempt}`,
      actorId: input.actorId ?? String(task.submission_actor_id),
      workUnit: "request",
      units: 1,
    });
    const fetched = await invokeSfpProviderTransport(pollReservation, () =>
      performOutscraperTaskResults(String(task.provider_task_id), {
        fetchImpl: input.fetchImpl,
        beforeRequest: () => assertCurrentSfpProviderReservation(pollReservation!),
        recordCreditSignal: input.recordCreditSignal,
      }));
    if (!fetched.ok || fetched.task?.state === "failed") {
      const providerFailed = fetched.task?.state === "failed" || fetched.status === 404;
      await finishSfpOperation({
        reservation: pollReservation,
        outcome: "completed",
        observation: "transport",
        businessId: Number(task.business_id),
        workCompleted: 1,
        providerUsage: providerUsage("known", "result", "0", null, "outscraper_task_poll_no_new_results"),
        resultData: { retrievalState: providerFailed ? "failed" : "retryable_error", providerReference: String(task.provider_task_id), externalTaskId: String(task.provider_task_id) },
      });
      if (providerFailed) {
        await finishSfpOperation({
          reservation: originalOutscraperReservation(task),
          outcome: "ambiguous", observation: "unknown", businessId: Number(task.business_id), workCompleted: 0,
          providerUsage: providerUsage("unknown", "result", undefined, String(task.provider_task_id), "outscraper_task_failed"),
          resultData: { retrievalState: "failed", providerReference: String(task.provider_task_id), externalTaskId: String(task.provider_task_id) },
        }).catch(() => {});
        await db.execute(sql`
          UPDATE sfp_provider_retrieval_tasks SET state='failed',lease_token=NULL,lease_expires_at=NULL,
                 last_error_code='OUTSCRAPER_ASYNC_TASK_FAILED',completed_at=NOW(),updated_at=NOW()
           WHERE id=${input.taskId}::uuid AND state='polling' AND lease_token=${leaseToken}::uuid
        `);
        await db.execute(sql`
          UPDATE sfp_stage_items SET state='failed',outcome_code='outscraper_task_failed',
                 completed_at=NOW(),updated_at=NOW()
           WHERE provider_operation_id=${String(task.submission_operation_id)}::uuid
        `);
        await finishOutscraperTaskStageRun(pollRun.id, pollRun.claimToken, "partial", 1);
        return { taskId: input.taskId, state: "failed", providerRequests: 1, errorCode: "OUTSCRAPER_ASYNC_TASK_FAILED" };
      }
      const delaySeconds = Math.min(900, 30 * 2 ** Math.min(Math.max(0, attempt - 1), 5));
      await db.execute(sql`
        UPDATE sfp_provider_retrieval_tasks SET state='submitted',lease_token=NULL,lease_expires_at=NULL,
               next_poll_at=NOW()+(${delaySeconds}::int*INTERVAL '1 second'),
               last_error_code='OUTSCRAPER_TASK_POLL_RETRY',updated_at=NOW()
         WHERE id=${input.taskId}::uuid AND state='polling' AND lease_token=${leaseToken}::uuid
      `);
      await finishOutscraperTaskStageRun(pollRun.id, pollRun.claimToken, "partial", 1);
      return { taskId: input.taskId, state: "pending", providerRequests: 1, errorCode: "OUTSCRAPER_TASK_POLL_RETRY" };
    }

    const pollReceipt = providerUsage("known", "result", "0", null, "outscraper_results_poll_no_new_results");
    await finishSfpOperation({
      reservation: pollReservation, outcome: "completed", observation: fetched.ok ? "valid" : "transport",
      businessId: Number(task.business_id), workCompleted: 1, providerUsage: pollReceipt,
      resultData: {
        retrievalState: fetched.task?.state ?? "completed",
        providerReference: String(task.provider_task_id),
        externalTaskId: String(task.provider_task_id),
      },
    });
    const persistedPollOperation = rows(await db.execute(sql`
      UPDATE sfp_provider_retrieval_tasks SET completion_operation_id=${pollReservation.operationId}::uuid,
             updated_at=NOW()
       WHERE id=${input.taskId}::uuid AND state='polling' AND lease_token=${leaseToken}::uuid
       RETURNING id
    `))[0];
    if (!persistedPollOperation) throw new Error("OUTSCRAPER_TASK_POLL_FENCE_LOST");
    let completionRetention: ReturnType<typeof deriveOutscraperResultRetentionBound> | null = null;
    if (fetched.task?.state === "completed") {
      completionRetention = deriveOutscraperResultRetentionBound({
        state: "completed",
        submittedAt: new Date(task.submitted_at).toISOString(),
        lastPendingObservedAt: task.completion_time_bound_kind === "last_pending_observed"
          ? new Date(task.completion_time_lower_bound_at).toISOString()
          : null,
        observedAt: new Date().toISOString(),
        existingResultsExpiresAt: new Date(task.results_expires_at).toISOString(),
      });
      if (completionRetention.expired) {
        const expired = await expireLeasedOutscraperTask({
          taskId: input.taskId, leaseToken, task,
          errorCode: "OUTSCRAPER_RESULTS_CONSERVATIVE_BOUND_REACHED",
        });
        await finishOutscraperTaskStageRun(pollRun.id, pollRun.claimToken, "partial", 1);
        return {
          taskId: input.taskId, state: expired ? "expired" : "deferred",
          providerRequests: 1, errorCode: "OUTSCRAPER_RESULTS_CONSERVATIVE_BOUND_REACHED",
        };
      }
      const original = originalOutscraperReservation(task);
      const resultCount = fetched.consideredResultCount;
      const hashes = fetched.results.map(outscraperResultHash);
      const invalidCode = resultCount > original.units ? "OUTSCRAPER_RESULT_LIMIT_EXCEEDED" : null;
      const resultsUsage = fetched.billing?.certainty === "exact" && fetched.billing.quantity !== undefined
        ? providerUsage("known", "result", fetched.billing.quantity, String(task.provider_task_id), "outscraper_maps_result_count")
        : providerUsage("unknown", "result", undefined, String(task.provider_task_id), "outscraper_maps_result_count");
      if (invalidCode) {
        await db.transaction(async (tx) => {
          await finishSfpOperation({
            reservation: original,
            outcome: "completed",
            observation: "invalid",
            businessId: Number(task.business_id),
            workCompleted: resultCount > original.units ? 0 : resultCount,
            providerUsage: resultsUsage,
            resultData: {
              retrievalState: invalidCode.toLowerCase(),
              providerReference: String(task.provider_task_id),
              externalTaskId: String(task.provider_task_id),
            },
          }, tx);
          const failedTask = rows(await tx.execute(sql`
            UPDATE sfp_provider_retrieval_tasks
               SET state='failed',completed_result_count=${resultCount},
                   completed_result_hashes=${JSON.stringify(hashes)}::jsonb,
                   last_error_code=${invalidCode},lease_token=NULL,lease_expires_at=NULL,
                   completed_at=NOW(),updated_at=NOW()
             WHERE id=${input.taskId}::uuid AND state='polling' AND lease_token=${leaseToken}::uuid
             RETURNING id
          `))[0];
          if (!failedTask) throw new Error("OUTSCRAPER_TASK_COMPLETION_FENCE_LOST");
          await tx.execute(sql`
            UPDATE sfp_stage_items
               SET state='failed',outcome_code=${invalidCode.toLowerCase()},
                   redacted_result=${JSON.stringify({
                     retrievalState: invalidCode.toLowerCase(),
                     providerReference: String(task.provider_task_id),
                     resultCount,
                   })}::jsonb,completed_at=NOW(),updated_at=NOW()
             WHERE provider_operation_id=${original.operationId}::uuid
          `);
        });
        if (resultsUsage.status === "known" && resultsUsage.providerRequestId) {
          await reconcileSfpUsageByRequest({
            provider: "outscraper", workUnit: "result", providerUsage: resultsUsage,
            reconciliationSource: "outscraper_maps_result_count",
          });
        }
        await finishOutscraperTaskStageRun(pollRun.id, pollRun.claimToken, "partial", 1);
        return {
          taskId: input.taskId, state: "failed", providerRequests: 1, resultCount,
          errorCode: invalidCode,
        };
      }
    }
    if (fetched.task?.state === "pending" || fetched.task?.state === "submitted") {
      const pendingObservedAt = new Date().toISOString();
      const retentionBound = deriveOutscraperResultRetentionBound({
        state: "pending",
        submittedAt: new Date(task.submitted_at).toISOString(),
        lastPendingObservedAt: task.completion_time_bound_kind === "last_pending_observed"
          ? new Date(task.completion_time_lower_bound_at).toISOString()
          : null,
        observedAt: pendingObservedAt,
        existingResultsExpiresAt: new Date(task.results_expires_at).toISOString(),
      });
      if (retentionBound.expired) {
        const expired = await expireLeasedOutscraperTask({
          taskId: input.taskId, leaseToken, task,
          errorCode: "OUTSCRAPER_RESULTS_CONSERVATIVE_BOUND_REACHED",
        });
        await finishOutscraperTaskStageRun(pollRun.id, pollRun.claimToken, "partial", 1);
        return {
          taskId: input.taskId, state: expired ? "expired" : "deferred",
          providerRequests: 1, errorCode: "OUTSCRAPER_RESULTS_CONSERVATIVE_BOUND_REACHED",
        };
      }
      const delaySeconds = Math.min(900, 30 * 2 ** Math.min(Math.max(0, attempt - 1), 5));
      const pendingTask = rows(await db.execute(sql`
        UPDATE sfp_provider_retrieval_tasks SET state='submitted',lease_token=NULL,lease_expires_at=NULL,
               next_poll_at=NOW()+(${delaySeconds}::int*INTERVAL '1 second'),
               completion_time_lower_bound_at=${retentionBound.completionTimeLowerBoundAt}::timestamptz,
               completion_time_bound_kind=${retentionBound.completionTimeBoundKind},
               results_expires_at=${retentionBound.resultsExpiresAt}::timestamptz,updated_at=NOW()
         WHERE id=${input.taskId}::uuid AND state='polling' AND lease_token=${leaseToken}::uuid
           AND results_expires_at>NOW()
         RETURNING id
      `))[0];
      if (!pendingTask) {
        const expired = await expireLeasedOutscraperTask({
          taskId: input.taskId, leaseToken, task,
          errorCode: "OUTSCRAPER_RESULTS_CONSERVATIVE_BOUND_REACHED",
        });
        await finishOutscraperTaskStageRun(pollRun.id, pollRun.claimToken, "partial", 1);
        return {
          taskId: input.taskId, state: expired ? "expired" : "deferred",
          providerRequests: 1, errorCode: "OUTSCRAPER_RESULTS_CONSERVATIVE_BOUND_REACHED",
        };
      }
      await finishOutscraperTaskStageRun(pollRun.id, pollRun.claimToken, "completed", 0);
      return { taskId: input.taskId, state: "pending", providerRequests: 1 };
    }

    const matched = fetched.results.filter((place) => outscraperMatchesPinnedBusiness(place, {
      canonical_name: task.business_name_snapshot,
      website_domain: task.domain_snapshot,
      city: task.city_snapshot,
      state: task.state_snapshot,
    }));
    const matchedPlaces = matched.length === 1 ? matched : [];
    const domains = [...new Set(matchedPlaces.map((place) => canonicalDomain(place.website)).filter((d): d is string => Boolean(d)))];
    let contactReservation: SfpProviderReservation | null = null;
    let contactsCount = 0;
    let contactsError: string | null = null;
    let contactUsage: SfpProviderUsageSettlement | null = null;
    if (domains.length) {
      let contactRun: { id: string; claimToken: string } | null = null;
      try {
        contactRun = await beginOutscraperTaskStageRun(
          task, `sfp-outs-task:${input.taskId}:contacts:${attempt}`,
          input.actorId ?? String(task.submission_actor_id),
        );
        contactReservation = await reserveSfpProviderOperation({
          stageRunId: contactRun.id,
          cohortRunId: task.cohort_run_id ? String(task.cohort_run_id):undefined,
          programId:task.program_id ?? undefined,
          businessId: Number(task.business_id),
          provider: "outscraper",
          purpose: "sfp_outscraper_leads_and_contacts",
          idempotencyKey: `sfp-outs-task:${input.taskId}:contacts`,
          actorId: input.actorId ?? String(task.submission_actor_id),
          workUnit: "contact",
          units: Math.max(1, domains.length * 3),
        });
        const persistedContactOperation = rows(await db.execute(sql`
          UPDATE sfp_provider_retrieval_tasks
             SET contact_operation_id=${contactReservation.operationId}::uuid,updated_at=NOW()
           WHERE id=${input.taskId}::uuid AND state='polling' AND lease_token=${leaseToken}::uuid
           RETURNING id
        `))[0];
        if (!persistedContactOperation) throw new Error("OUTSCRAPER_TASK_CONTACT_FENCE_LOST");
        if (!contactReservation.replayed) {
          const contacts = await invokeSfpProviderTransport(contactReservation, () =>
            performOutscraperLeadsAndContacts(domains, {
              fetchImpl: input.fetchImpl,
              beforeRequest: () => assertCurrentSfpProviderReservation(contactReservation!),
              recordCreditSignal: input.recordCreditSignal,
            }));
          if (!contacts.ok) throw new Error("OUTSCRAPER_LEADS_CONTACTS_HTTP_ERROR");
          contactsCount = contacts.consideredContactCount;
          contactUsage = contacts.billing.certainty === "exact" && contacts.billing.quantity !== undefined
            ? providerUsage("known", contacts.billing.unit, contacts.billing.quantity, contacts.billing.providerReference, "outscraper_leads_contacts")
            : providerUsage("unknown", contacts.billing.unit, undefined, contacts.billing.providerReference, "outscraper_leads_contacts");
          if (contactsCount > contactReservation.units) {
            throw new Error("OUTSCRAPER_CONTACT_RESULT_LIMIT_EXCEEDED");
          }
          const contactEvidence = await db.transaction(async (tx) => {
            const written = [];
            for (const record of contacts.records) {
              if (!domains.includes(canonicalDomain(record.query) ?? canonicalDomain(record.website) ?? "")) continue;
              for (const candidate of namedOutscraperEmailCandidates(record)) {
                written.push(await writeSfpPaidCandidateEvidence({
                  businessId: Number(task.business_id),
                  provider: "outscraper",
                  field: "email",
                  value: candidate.email,
                  subjectType: "person",
                  providerOperationId: contactReservation!.operationId,
                  confidence: 65,
                  personNameEvidence: candidate.name,
                  personTitleEvidence: candidate.title,
                  candidateMetadata: { source: "outscraper_leads_contacts" },
                }, tx));
              }
            }
            await finishSfpOperation({
              reservation: contactReservation!,
              outcome: "completed",
              observation: "valid",
              businessId: Number(task.business_id),
              workCompleted: contactsCount,
              providerUsage: contactUsage!,
              resultData: {
                retrievalState: "completed",
                providerReference: contacts.billing.providerReference,
              },
            }, tx);
            if (written[0]) {
              await tx.execute(sql`
                UPDATE sfp_stage_items
                   SET paid_candidate_evidence_id=${written[0].id}::uuid,
                       outcome_code='candidate_found',updated_at=NOW()
                 WHERE provider_operation_id=${contactReservation!.operationId}::uuid
              `);
            }
            return contactUsage!;
          });
          if (contactEvidence.status === "known" && contactEvidence.providerRequestId) {
            await reconcileSfpUsageByRequest({
              provider: "outscraper",
              workUnit: "contact",
              providerUsage: contactEvidence,
              reconciliationSource: "outscraper_leads_contacts_receipt",
            });
          }
        }
        await finishOutscraperTaskStageRun(contactRun.id, contactRun.claimToken, "completed", 0);
      } catch (error: any) {
        contactsError = String(error?.message ?? error).slice(0, 120);
        if (contactReservation) await finishSfpOperation({
          reservation: contactReservation,
          outcome: "failed",
          observation: "transport",
          businessId: Number(task.business_id),
          workCompleted: 0,
          providerUsage: contactUsage ??
            providerUsage("unknown", "contact", undefined, null, "outscraper_leads_contacts"),
          resultData: { retrievalState: "failed" },
        }).catch(() => {});
        if (contactRun) await finishOutscraperTaskStageRun(contactRun.id, contactRun.claimToken, "partial", 1).catch(() => {});
      }
    }

    const original = originalOutscraperReservation(task);
    const mapsUsage = fetched.billing?.certainty === "exact" && fetched.billing.quantity !== undefined
      ? providerUsage("known", "result", fetched.billing.quantity, String(task.provider_task_id), "outscraper_maps_result_count")
      : providerUsage("unknown", "result", undefined, String(task.provider_task_id), "outscraper_maps_result_count");
    const matchedPlace = matchedPlaces[0] ?? null;
    const businessValues = matchedPlace ? businessCandidateValues(matchedPlace) : [];
    const allNamedContacts = matchedPlace
      ? namedOutscraperEmailCandidates(matchedPlace)
      : [];
    const uniqueNamedContacts = [...new Map(allNamedContacts.map((contact) => [
      `${contact.email.toLowerCase()}\n${normalizedIdentity(contact.name)}\n${normalizedIdentity(contact.title)}`,
      contact,
    ])).values()];
    const resultCount = fetched.consideredResultCount;
    const terminalState = resultCount === 0 ? "no_result" as const : "completed" as const;
    const hashes = fetched.results.map(outscraperResultHash);
    await db.transaction(async (tx) => {
      const evidence = [];
      for (const item of businessValues) {
        evidence.push(await writeSfpPaidCandidateEvidence({
          businessId: Number(task.business_id),
          provider: "outscraper",
          field: item.field,
          value: item.value,
          subjectType: "business",
          providerOperationId: original.operationId,
          confidence: 70,
          candidateMetadata: { source: "outscraper", placeId: matchedPlace?.placeId ?? null },
        }, tx));
      }
      for (const contact of uniqueNamedContacts) {
        evidence.push(await writeSfpPaidCandidateEvidence({
          businessId: Number(task.business_id),
          provider: "outscraper",
          field: "email",
          value: contact.email,
          subjectType: "person",
          providerOperationId: contactReservation?.operationId ?? original.operationId,
          confidence: 65,
          personNameEvidence: contact.name,
          personTitleEvidence: contact.title,
          candidateMetadata: { source: contactReservation ? "outscraper_leads_contacts" : "outscraper_maps_contacts" },
        }, tx));
      }
      if (matchedPlace) {
        await tx.execute(sql`
          UPDATE businesses SET
            website_domain=COALESCE(website_domain,${canonicalDomain(matchedPlace.website)}),
            main_phone=COALESCE(main_phone,${matchedPlace.phone}),
            street_address=COALESCE(street_address,${matchedPlace.address}),
            city=COALESCE(city,${matchedPlace.city}),
            state=COALESCE(state,${matchedPlace.state}),
            postal_code=COALESCE(postal_code,${matchedPlace.zip}),
            updated_at=NOW()
           WHERE id=${Number(task.business_id)}
        `);
      }
      await finishSfpOperation({
        reservation: original,
        outcome: terminalState,
        observation: matchedPlace ? "valid" : resultCount ? "unknown" : "no_result",
        businessId: Number(task.business_id),
        workCompleted: resultCount,
        providerUsage: mapsUsage,
        resultData: {
          retrievalState: contactsError ? "completed_with_contacts_error" : "completed",
          providerReference: String(task.provider_task_id),
          externalTaskId: String(task.provider_task_id),
        },
      }, tx);
      const completedTask = rows(await tx.execute(sql`
        UPDATE sfp_provider_retrieval_tasks
           SET state=${terminalState},contact_operation_id=${contactReservation?.operationId ?? null}::uuid,
                completion_time_lower_bound_at=${completionRetention!.completionTimeLowerBoundAt}::timestamptz,
                completion_time_bound_kind=${completionRetention!.completionTimeBoundKind},
                results_expires_at=${completionRetention!.resultsExpiresAt}::timestamptz,
               completed_result_count=${resultCount},
               completed_result_hashes=${JSON.stringify(hashes)}::jsonb,
                last_error_code=${contactsError ? "OUTSCRAPER_LEADS_CONTACTS_ERROR" : null},
               lease_token=NULL,lease_expires_at=NULL,completed_at=NOW(),updated_at=NOW()
         WHERE id=${input.taskId}::uuid AND state='polling' AND lease_token=${leaseToken}::uuid
         RETURNING id
      `))[0];
      if (!completedTask) throw new Error("OUTSCRAPER_TASK_COMPLETION_FENCE_LOST");
      await tx.execute(sql`
        UPDATE sfp_stage_items
           SET state=${terminalState},outcome_code=${matchedPlace ? "candidate_found" : terminalState},
               paid_candidate_evidence_id=${evidence[0]?.id ?? null}::uuid,
               redacted_result=${JSON.stringify({
                 retrievalState: terminalState,
                 providerReference: String(task.provider_task_id),
                 resultCount,
                 matchedBusiness: Boolean(matchedPlace),
                 namedContactCount: uniqueNamedContacts.length,
               })}::jsonb,completed_at=NOW(),updated_at=NOW()
         WHERE provider_operation_id=${original.operationId}::uuid
      `);
    });
    if (mapsUsage.status === "known" && mapsUsage.providerRequestId) {
      await reconcileSfpUsageByRequest({
        provider: "outscraper", workUnit: "result", providerUsage: mapsUsage,
        reconciliationSource: "outscraper_maps_result_count",
      });
    }
    await finishOutscraperTaskStageRun(pollRun.id, pollRun.claimToken, "completed", 0);
    return {
      taskId: input.taskId,
      state: terminalState,
      providerRequests: 1 + (contactReservation ? 1 : 0),
      resultCount,
      contactCount: contactsCount,
      ...(contactsError ? { errorCode: "OUTSCRAPER_LEADS_CONTACTS_ERROR" } : {}),
    };
  } catch (error: any) {
    if (pollReservation) await finishSfpOperation({
      reservation: pollReservation,
      outcome: "completed",
      observation: "transport",
      businessId: Number(task.business_id),
      workCompleted: 1,
      providerUsage: providerUsage("known", "result", "0", null, "outscraper_task_poll_no_new_results"),
    }).catch(() => {});
    const delaySeconds = Math.min(900, 30 * 2 ** Math.min(Math.max(0, attempt - 1), 5));
    await db.execute(sql`
      UPDATE sfp_provider_retrieval_tasks SET state='submitted',lease_token=NULL,lease_expires_at=NULL,
             next_poll_at=NOW()+(${delaySeconds}::int*INTERVAL '1 second'),
             last_error_code='OUTSCRAPER_TASK_WORKER_RETRY',updated_at=NOW()
       WHERE id=${input.taskId}::uuid AND state='polling' AND lease_token=${leaseToken}::uuid
    `).catch(() => {});
    await finishOutscraperTaskStageRun(pollRun.id, pollRun.claimToken, "partial", 1).catch(() => {});
    return {
      taskId: input.taskId, state: "pending", providerRequests: pollReservation ? 1 : 0,
      errorCode: String(error?.message ?? error).slice(0, 120),
    };
  }
}

/** Read-only selection shared by execution and disposable-DB certification. */
export async function selectSfpSerperTargets(cohortRunId: string, maxBusinesses: number): Promise<any[]> {
  return rows(await db.execute(sql`
    SELECT b.id,b.canonical_name,b.city,b.state,b.postal_code,b.street_address,b.website_domain,m.roi_score
      FROM sfp_cohort_members m JOIN businesses b ON b.id=m.business_id
     WHERE m.cohort_run_id=${cohortRunId}::uuid
       AND b.website_domain IS NULL
       AND NOT EXISTS (SELECT 1 FROM free_discovery_candidates c WHERE c.business_id=b.id AND c.disposition IN ('staged','validation_admitted'))
       AND NOT EXISTS (
         SELECT 1 FROM sfp_stage_items i JOIN sfp_stage_runs prior ON prior.id=i.stage_run_id
          WHERE prior.cohort_run_id=m.cohort_run_id AND i.business_id=b.id
            AND i.provider='serper' AND i.state IN ('completed','no_result')
       )
       -- A new frozen cohort must not pay for the same terminal no-result
       -- lookup again immediately. A voided prior cohort does not invalidate
       -- the settled observation for this business. Retry is allowed after
       -- the finite cooldown expires.
       AND NOT EXISTS (
         SELECT 1 FROM sfp_stage_items i WHERE i.business_id=b.id
           AND i.provider='serper' AND i.state='no_result'
           AND i.completed_at >= NOW() - INTERVAL '24 hours'
       )
       AND NOT EXISTS (SELECT 1 FROM sfp_identity_quarantines q
         WHERE q.business_id=b.id AND q.cleared_at IS NULL)
     ORDER BY m.roi_score DESC,b.id ASC LIMIT ${maxBusinesses}
  `));
}

export async function executeSfpSerperDiscovery(input: {
  cohortRunId?:string;
  programId?:string;
  idempotencyKey:string;
  actorId:string;
  maxBusinesses?:number;
  previewSnapshotHash?:string;
  internalSkipPreviewCheck?:boolean;
  /** "unlabeled" admits businesses with no effective vertical for evidence discovery. It is
   * closed unless an admin setting enables it with positive request allowances. */
  scope?:DiscoveryScope;
}) {
  const maxBusinesses=Math.max(1,Math.min(25,Number(input.maxBusinesses ?? 10)));
  if(Boolean(input.programId)===Boolean(input.cohortRunId)) throw new Error("SFP_DISCOVERY_SCOPE_REQUIRED");
  const scope:DiscoveryScope=input.scope ?? "target_vertical";
  let allowance:RequestAllowance|null=null;
  if(scope==="unlabeled"){
    if(!input.programId) throw new Error("SFP_UNLABELED_DISCOVERY_REQUIRES_PROGRAM");
    const gate=await readUnlabeledDiscoveryGate();
    if(!gate.enabled) throw new Error("SFP_UNLABELED_DISCOVERY_DISABLED");
    allowance=createDurableRequestAllowance(gate,randomUUID());
    if(!(await allowance.canStart())) throw new Error("SFP_UNLABELED_DISCOVERY_ALLOWANCE_EXHAUSTED");
  }
  const programSelection=input.programId
    ? await programDiscoverySelection(input.programId,input.idempotencyKey,maxBusinesses,"serper",scope):null;
  if (!programSelection && !input.internalSkipPreviewCheck) {
    if (!input.previewSnapshotHash) throw new Error("SFP_PREVIEW_REQUIRED");
    const currentPreview=await getSfpCohortGapSnapshot(input.cohortRunId!);
    if(currentPreview.snapshotHash!==input.previewSnapshotHash) throw new Error("SFP_STALE_PREVIEW");
  }
  const cohortHashRow=programSelection?null:rows(await db.execute(sql`SELECT cohort_hash FROM sfp_cohort_runs WHERE id=${input.cohortRunId!}::uuid`))[0];
  if(!programSelection && !cohortHashRow) throw new Error("SFP_COHORT_RUN_NOT_FOUND");
  const payloadHash=sha256({cohortRunId:input.cohortRunId,programId:input.programId,
    cohortHash:programSelection?sha256(programSelection.snapshot):cohortHashRow.cohort_hash,maxBusinesses,
    providers:["serper"],order:["serper","free_first_party_recrawl"],previewSnapshotHash:input.previewSnapshotHash ?? null,
    ...(scope!=="target_vertical"?{scope}:{})});
  const existing=rows(await db.execute(sql`
    SELECT * FROM sfp_stage_runs WHERE stage='paid_waterfall' AND idempotency_key=${input.idempotencyKey} LIMIT 1
  `))[0];
  if(existing?.payload_hash && String(existing.payload_hash)!==payloadHash) throw new Error("SFP_IDEMPOTENCY_PAYLOAD_MISMATCH");
  if(existing?.state==='completed') return {stageRunId:String(existing.id),replayed:true,processed:Number(existing.processed_count),succeeded:Number(existing.succeeded_count),failed:Number(existing.failed_count),providerRequests:0};
  const stage=existing ?? rows(await db.execute(sql`
     INSERT INTO sfp_stage_runs(cohort_run_id,program_id,selection_snapshot,stage,idempotency_key,actor_id,state,max_items,provider_keys,payload_hash,preview_snapshot_hash,started_at,last_heartbeat_at)
     VALUES(${input.cohortRunId ?? null}::uuid,${input.programId ?? null}::uuid,
       ${programSelection?JSON.stringify(programSelection.snapshot):null}::jsonb,
       'paid_waterfall',${input.idempotencyKey},${input.actorId},'authorized',${maxBusinesses},'["serper"]'::jsonb,${payloadHash},${input.previewSnapshotHash ?? null},NOW(),NOW())
    ON CONFLICT(stage,idempotency_key) DO UPDATE SET updated_at=NOW() RETURNING *
  `))[0];
   const stageClaimToken=await claimStageRun(String(stage.id));
  const targets=programSelection?.targets ?? await selectSfpSerperTargets(input.cohortRunId!,maxBusinesses);
  await db.execute(sql`UPDATE sfp_stage_runs SET selected_count=${targets.length},updated_at=NOW() WHERE id=${String(stage.id)}::uuid`);
  let succeeded=0,failed=0,noResult=0,freeRecrawlFailed=0,providerRequests=0,memorySkipped=0;
  // Truthful work accounting: selected, attempted, memory-skipped and allowance-deferred
  // are separate. A business never reached, or stopped before its lookup finished, is
  // deferred (nothing remembered, selectable again), never counted as processed.
  let attempted=0,allowanceDeferred=0,deferredAfterSpend=0,stopReason:string|null=null;
  for(let targetIndex=0;targetIndex<targets.length;targetIndex++){
    const target=targets[targetIndex];
     await renewStageRunClaim(String(stage.id),stageClaimToken);
    if(allowance && !(await allowance.canStart())){
      stopReason=`allowance_exhausted:${allowance.snapshot().denial ?? "unknown"}`;
      allowanceDeferred+=targets.length-targetIndex;
      break;
    }
    // One worker at a time may buy a business's lookup, and a fresh remembered outcome wins.
    // The claim pins the exact inputs this lookup is sent with.
    const lookupClaimToken=randomUUID();
    if(!(await claimSerperLookup(Number(target.id),lookupClaimToken,{canonicalName:target.canonical_name,
      streetAddress:target.street_address,city:target.city,state:target.state,postalCode:target.postal_code}))){ memorySkipped++; continue; }
    let lookupRecorded=false;
    let reservation:Awaited<ReturnType<typeof reserveSfpProviderOperation>>|null=null;
    try{
      reservation=await reserveSfpProviderOperation({
        stageRunId:String(stage.id),cohortRunId:input.cohortRunId,businessId:Number(target.id),provider:"serper",
        programId:input.programId,
        purpose:"sfp_official_domain_discovery",idempotencyKey:`${input.idempotencyKey}:serper:${target.id}`,
        actorId:input.actorId,workUnit:"request",units:4,
      });
      if(reservation.replayed){
        await releaseSerperLookupClaim(Number(target.id),lookupClaimToken); lookupRecorded=true;
        noResult++; continue;
      }
      providerRequests++;
      attempted++;
       const outcome=await invokeSfpProviderTransport(reservation,() => lookupBusinessIdentity({
         businessName:String(target.canonical_name),zip:target.postal_code,city:target.city,state:target.state,address:target.street_address,
         requireGeographicCorroboration:true,
       },{caller:scope==="unlabeled"?UNLABELED_DISCOVERY_CALLER:"server/services/cro03/sfp-paid-waterfall.ts",
         ...(allowance?{authorizeRequest:allowance.authorizeRequest,onRequestSettled:allowance.onRequestSettled,onRequestNotSent:allowance.onRequestNotSent}:{})}));
        const serperUsage = normalizeSfpProviderUsage({
          status: "known", quantity: String(outcome.requestsUsed), unit: "request",
          source: "serper_business_identity",
        });
       providerRequests+=Math.max(0,Number(outcome.requestsUsed ?? 1)-1);
      if(outcome.kind==='accepted_match' && outcome.accepted){
        const acceptedIdentity = outcome.accepted;
        let domain:string|null=null;
        if(acceptedIdentity.website){
          try{domain=new URL(acceptedIdentity.website.startsWith('http')?acceptedIdentity.website:`https://${acceptedIdentity.website}`).hostname.replace(/^www\./,'').toLowerCase();}catch{domain=null;}
        }
        const identityCandidates = [
          ...(domain ? [{ field: "website_domain", value: domain }] : []),
          ...(acceptedIdentity.phone ? [{ field: "phone", value: acceptedIdentity.phone }] : []),
          // The listing's own category is classification evidence even when the listing has no
          // website. It is stored as raw evidence only; #2087's authority decides any vertical.
          ...(acceptedIdentity.category?.trim()
            ? [{ field: "listing_category", value: acceptedIdentity.category.trim().slice(0,120) }] : []),
        ];
        await db.transaction(async (tx) => {
          const evidence = [];
          for (const candidate of identityCandidates) {
            evidence.push(await writeSfpPaidCandidateEvidence({
              businessId: Number(target.id), provider: "serper", field: candidate.field,
              value: candidate.value, subjectType: "business", providerOperationId: reservation!.operationId,
              confidence: candidate.field === "listing_category" ? 80 : 90,
              candidateMetadata: { acceptedIdentityMatch: true, endpoint: acceptedIdentity.endpoint, strategy: acceptedIdentity.strategy },
            }, tx));
          }
          await tx.execute(sql`
            UPDATE businesses SET website_domain=COALESCE(website_domain,${domain}),main_phone=COALESCE(main_phone,${acceptedIdentity.phone}),updated_at=NOW()
             WHERE id=${Number(target.id)}
          `);
          await settleSfpProviderOperation({
            reservation: reservation!,outcome:'completed',observation:'unknown',businessId:Number(target.id),
             settledUnits:outcome.requestsUsed,providerUsage:serperUsage,
             resultData:{domain,reasonCode:domain ? "SERPER_DOMAIN_DISCOVERED" : "SERPER_IDENTITY_MATCH_NO_DOMAIN",reportedCredits:outcome.reportedCredits ?? null,fallbackSkippedReason:outcome.fallbackSkippedReason ?? null},
          },tx);
          if (evidence.length) {
            await tx.execute(sql`
              UPDATE sfp_stage_items SET paid_candidate_evidence_id=${evidence[0].id}::uuid,
                     outcome_code=${identityCandidates[0].field==="listing_category"?"listing_category_evidence":"candidate_found"},updated_at=NOW()
               WHERE provider_operation_id=${reservation!.operationId}::uuid
            `);
          }
        });
        // Remember an accepted identity that yielded no website so it is not re-bought.
        await recordSerperLookupOutcome({businessId:Number(target.id),claimToken:lookupClaimToken,outcome,discoveredDomain:!!domain});
        lookupRecorded=true;
        if(domain){
          // Domain discovery is a paid-stage success even if the subsequent
          // free crawl fails. The canonical free lane owns its own retry state.
          try { await runFreeEnrichmentLane([Number(target.id)]); }
          catch { freeRecrawlFailed++; }
          succeeded++;
        }else{
          noResult++;
        }
      }else if(outcome.kind==='blocked' && outcome.reason==='allowance_exhausted'){
        // The allowance stopped this lookup. Nothing is concluded or remembered: release the
        // claim and leave the business selectable, even if an earlier request of it was paid.
        await settleSfpProviderOperation({
          reservation,outcome:'failed',observation:'transport',businessId:Number(target.id),
          ...(outcome.requestsUsed>0?{settledUnits:outcome.requestsUsed,providerUsage:serperUsage}:{}),
          resultData:{reasonCode:"SERPER_ALLOWANCE_DEFERRED",requestsBeforeStop:outcome.requestsUsed,reportedCredits:outcome.reportedCredits ?? null},
        });
        await releaseSerperLookupClaim(Number(target.id),lookupClaimToken); lookupRecorded=true;
        await db.execute(sql`UPDATE sfp_stage_items SET state='failed',outcome_code='allowance_deferred',completed_at=NOW(),updated_at=NOW() WHERE provider_operation_id=${reservation.operationId}::uuid`);
        if(outcome.requestsUsed>0) deferredAfterSpend++; else { providerRequests--; attempted--; }
        allowanceDeferred++;
        stopReason=`allowance_exhausted:${allowance?.snapshot().denial ?? "unknown"}`;
        allowanceDeferred+=targets.length-targetIndex-1;
        break;
      }else{
        await settleSfpProviderOperation({
          reservation,outcome:'no_result',observation:'no_result',businessId:Number(target.id),
           settledUnits:outcome.requestsUsed,providerUsage:serperUsage,resultData:{
            domain:null,
            reasonCode:serperReasonCode(outcome.kind),
            lookupOutcome:outcome.kind,
            rejectionSummary:outcome.rejectionSummary ?? null,
            fallbackSkippedReason:outcome.fallbackSkippedReason ?? null,
            reportedCredits:outcome.reportedCredits ?? null,
          },
        });
        // Provider failures and control blocks are remembered only briefly or not at all;
        // genuine negatives are remembered under the current inputs and rule version.
        await recordSerperLookupOutcome({businessId:Number(target.id),claimToken:lookupClaimToken,outcome,discoveredDomain:false});
        lookupRecorded=true;
        noResult++;
      }
    }catch(error:any){
      if(!lookupRecorded) await releaseSerperLookupClaim(Number(target.id),lookupClaimToken).catch(()=>{});
      if(reservation) await settleSfpProviderOperation({reservation,outcome:'failed',observation:'transport',businessId:Number(target.id)}).catch(()=>{});
      failed++;
      await db.execute(sql`UPDATE sfp_stage_items SET state='failed',outcome_code=${String(error?.message ?? error).slice(0,180)},completed_at=NOW(),updated_at=NOW() WHERE stage_run_id=${String(stage.id)}::uuid AND business_id=${Number(target.id)} AND provider='serper'`).catch(()=>{});
    }
  }
  // Completed work only: a lookup stopped after spending is attempted but not processed.
  const processedCount=attempted-deferredAfterSpend+memorySkipped;
  await db.execute(sql`
    UPDATE sfp_stage_runs SET state=${failed||allowanceDeferred?"partial":"completed"},claim_token=NULL,lease_expires_at=NULL,processed_count=${processedCount},succeeded_count=${succeeded},
           failed_count=${failed},skipped_count=${noResult},terminal_reason=${stopReason},completed_at=NOW(),last_heartbeat_at=NOW(),updated_at=NOW()
     WHERE id=${String(stage.id)}::uuid AND claim_token=${stageClaimToken}::uuid
  `);
  return {stageRunId:String(stage.id),replayed:false,selected:targets.length,processed:processedCount,attempted,succeeded,failed,noResult,freeRecrawlFailed,providerRequests,memorySkipped,
    allowanceDeferred,stopReason,
    ...(allowance?{allowance:allowance.snapshot()}:{}),zeroOutreachConfirmed:true};
}

function serperReasonCode(kind:string):string{
  switch(kind){
    case 'identity_rejected': return 'SERPER_IDENTITY_REJECTED';
    case 'ambiguous': return 'SERPER_AMBIGUOUS';
    case 'provider_failure': return 'SERPER_PROVIDER_FAILURE';
    case 'blocked': return 'SERPER_LOOKUP_BLOCKED';
    default: return 'SERPER_NO_RESULT';
  }
}
