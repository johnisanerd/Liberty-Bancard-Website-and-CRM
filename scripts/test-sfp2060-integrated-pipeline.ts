#!/usr/bin/env npx tsx
/**
 * Task 2060 integrated disposable PostgreSQL certification.
 *
 * All external provider responses are deterministic fixtures injected at the
 * real provider transport boundary. Every SFP validation/discovery request
 * still uses its normal reservation, dispatch, and settlement path. The
 * fixture authority, users, and all resulting evidence live only in the
 * private database created by run-sfp2060-certification-disposable.ts; none
 * of the approvals below is represented as production review.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { promises as dns } from "node:dns";
import { sql } from "drizzle-orm";
import {
  applyCertificationProviderDenyBoundary,
  getBlockedCertificationNetworkAttemptCount,
} from "./certification-provider-deny";
import { assertDisposableTestInfrastructure } from "./test-infrastructure-guard";

await assertDisposableTestInfrastructure({
  operation: "Task #2060 integrated SFP pipeline certification",
  requireRedis: false,
});

process.env.VG_PROVIDER_DENY_MODE = "1";
applyCertificationProviderDenyBoundary({ fatal: true });

// Replace only the normal ZeroBounce fetch. Any other non-loopback request
// still reaches the certification deny boundary.
const denyFetch = globalThis.fetch;
const fakeZeroBounceKey = "task-2060-disposable-zero-bounce-key";
process.env.ZEROBOUNCE_API_KEY = fakeZeroBounceKey;
process.env.OUTSCRAPER_API_KEY = "task-2060-disposable-outscraper-key";
process.env.APOLLO_API_KEY = "task-2060-disposable-apollo-key";
process.env.CRO03_PROVIDER_TRANSPORT_ENABLED = "true";
process.env.FREE_DISCOVERY_VALIDATION_PROMOTION_ENABLED = "true";

let zeroBounceCalls = 0;
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (url.origin === "https://api.zerobounce.net" && url.pathname === "/v2/validate") {
    if (url.searchParams.get("api_key") !== fakeZeroBounceKey) {
      throw new Error("TASK_2060_FAKE_ZEROBOUNCE_KEY_MISMATCH");
    }
    zeroBounceCalls++;
    return new Response(JSON.stringify({ status: "valid", sub_status: "" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return denyFetch(input, init);
}) as typeof fetch;

// The real MX gate remains in the validation path; only its DNS answer is
// deterministic so the disposable suite never makes a DNS/network request.
(dns as any).resolveMx = async () => [{ exchange: "mx.task2060.invalid", priority: 10 }];

const rows = (result: any): any[] => result?.rows ?? result ?? [];
const safeProviderDiagnosticCode = (value: unknown): string | null => {
  const code = String(value ?? "");
  if (!code) return null;
  if (!/^[A-Za-z][A-Za-z0-9_:-]{0,119}$/.test(code) ||
      /^[a-f0-9]{32,}$/i.test(code) ||
      /(api[_-]?key|access[_-]?token|secret|password|bearer|authorization)/i.test(code)) {
    return "[redacted]";
  }
  return code;
};
const sha256 = (value: unknown): string =>
  createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const runKey = `sfp2060-${randomUUID()}`;
const actorId = `${runKey}-admin`;
const sourceActorId = `${runKey}-contact-source-owner`;
const routeReviewerId = `${runKey}-named-email-review-admin`;
const vertical = "Construction/Trades/Home Services";
const packageKey = "sfp.construction_trades_home_services.v2";
const sharedDomain = "suncoast-trades.com";
const sharedEmail = `info@${sharedDomain}`;
const paidDomain = `task-2060-${runKey.slice(-12)}.paid.example`;
const paidEmail = `sales@${paidDomain}`;
const contactDomain = "palmetto-wellness.com";
const contactEmail = `frontdesk@${contactDomain}`;

let pool: any;
let reviewApiServer: any;
let reviewApiBaseUrl = "";

try {
  // This helper supplies only process/deployment identity. Runtime ownership
  // itself is claimed through assertSfpRuntimeAuthority below; no
  // CRO03C/fleet attestation is inserted or fabricated.
  await (await import("./helpers/sfp-runtime-test-identity")).getSfpRuntimeTestIdentity();

  const { db, pool: appPool } = await import("../server/db");
  pool = appPool;
  const { initializePauseControl, applyPauseMutation } =
    await import("../server/services/outbound-control-service");
  const initializedPause = await initializePauseControl();
  const canonicalPause = initializedPause.state === "paused"
    ? initializedPause
    : await applyPauseMutation({
        outboundGlobalPaused: true,
        reason: "Task 2060 disposable integrated pipeline certification",
        actor: `${runKey}-certification`,
        idempotencyKey: `${runKey}-outbound-pause`,
      }).then((result) => result.control);
  if (canonicalPause.state !== "paused") {
    throw new Error("TASK_2060_CANONICAL_OUTBOUND_PAUSE_NOT_ESTABLISHED");
  }
  const express = (await import("express")).default;
  const { registerLeadOpsRoutes } = await import("../server/routes/lead-ops");
  const { writeContact } = await import("../server/services/contact-writer");
  const {
    decideContactBusinessLink,
    recordContactBusinessLinkCandidate,
  } = await import("../server/services/commercial-link-authority");
  const {
    completeFreeDiscoveryGeneration,
    createFreeDiscoveryGeneration,
    recordFreeDiscoveryCandidate,
  } = await import("../server/services/free-discovery/evidence-service");
  const { hashEmailToken } = await import("../server/services/provider-readiness-decision");
  const {
    previewSfpValidation,
    executeSfpValidation,
  } = await import("../server/services/cro03/sfp-validation");
  const { getUnifiedSfpCandidates, openSfpCandidatePlaintext } =
    await import("../server/services/cro03/sfp-paid-evidence-writer");
  const {
    previewSfpPaidWaterfall,
    executeSfpPaidPersonAndIdentityDiscovery,
  } = await import("../server/services/cro03/sfp-paid-waterfall");
  const { getSfpCohortGapSnapshot } = await import("../server/services/cro03/sfp-cost-preview");
  const {
    previewStagingV2,
    executeStagingV2,
  } = await import("../server/services/cro03/sfp-campaign-staging-v2");
  const { computeLivePackageContentHash } = await import("../server/services/cro03/sfp-campaign-packages");
  const { bridgeReadyHeldIntentToPausedEnrollment } =
    await import("../server/services/cro03/sfp-enrollment-bridge");
  const { classifyVertical, CLASSIFIER_VERSION } =
    await import("../server/services/cro03/sfp-vertical-classifier");
  const { resolveGeographyFromCandidates } =
    await import("../server/services/cro03/sfp-geography-resolver");
  const {
    assertSfpRuntimeAuthority,
    finishSfpProviderOperation,
    invokeSfpProviderTransport,
    claimSfpRuntimeDeploymentOwner,
    getSfpRuntimeReleaseSelectionStatus,
    reconcileSfpProviderUsage,
    reserveSfpProviderOperation,
    renewSfpRuntimeDeploymentOwner,
    selectCurrentSfpRuntimeRelease,
  } = await import("../server/services/cro03/sfp-provider-operations");
  const { executeSfpApolloDiscovery } =
    await import("../server/services/cro03/sfp-live-provider-adapters");
  const {
    calculateSfpUsageCostMicros,
    normalizeSfpProviderUsage,
  } = await import("../server/services/cro03/sfp-billing-contract");
  const { sfpRecipientIdentityHash } =
    await import("../server/services/cro03/sfp-recipient-link-predicates");
  const {
    authorizePaidBudget,
    MI09_PAID_BUDGET_TYPED_CONFIRMATION,
  } = await import("../server/services/mi09-pilot-authority");

  const originalUsers = rows(await db.execute(sql`
    INSERT INTO users (id,email,first_name,last_name,role)
    VALUES
      (${actorId},${`${runKey}-admin@cert.invalid`},'Task2060','Admin','admin'),
      (${sourceActorId},${`${runKey}-source@cert.invalid`},'Task2060','Source Owner','user'),
      (${routeReviewerId},${`${runKey}-named-review@cert.invalid`},'Task2060','Independent Review','admin')
    RETURNING id,role
  `));
  assert.equal(originalUsers.length, 3, "the disposable source, pipeline, and independent review actors are persisted");
  assert.notEqual(actorId, sourceActorId, "contact evidence owner and independent reviewer are distinct users");
  assert.notEqual(actorId, routeReviewerId, "named-email reviewer is distinct from the validation actor");
  const releaseSelection = await (await import("./helpers/sfp-runtime-test-identity"))
    .selectSfpRuntimeTestRelease(actorId);
  assert.equal(releaseSelection.currentReleaseSelected, true,
    "the disposable admin selects the current test release through the audited selector API");
  assert.equal(releaseSelection.selectedRelease?.selectedBy, actorId);
  assert.equal(releaseSelection.selectedRelease?.selectionVersion, 1,
    "a fresh private database bootstraps exactly the first release-selection version");
  assert.equal(releaseSelection.ownerLive, true,
    "audited selection establishes the current process owner lease");
  assert.equal(releaseSelection.ready, true,
    "selected release is ready only with its live matching owner lease");
  const bootstrapSelectionEvent = rows(await db.execute(sql`
    SELECT action,actor_id,previous_selection,selected_release,publisher_verification_reference
      FROM sfp_runtime_release_selection_events
     WHERE id=${releaseSelection.selectedRelease!.selectionEventId}::uuid
  `))[0];
  assert.equal(bootstrapSelectionEvent.action, "bootstrap");
  assert.equal(bootstrapSelectionEvent.actor_id, actorId);
  assert.equal(bootstrapSelectionEvent.previous_selection, null);
  assert.equal(
    bootstrapSelectionEvent.publisher_verification_reference,
    releaseSelection.selectedRelease?.verificationReference,
    "the normal selector API persists its publisher-verification audit event",
  );
  await assert.rejects(
    () => selectCurrentSfpRuntimeRelease({
      actorId,
      expectedPreviousArtifactSha: releaseSelection.selectedRelease!.artifactSha,
      expectedPreviousSelectionVersion: releaseSelection.selectedRelease!.selectionVersion + 1,
      publisherVerifiedArtifactSha: releaseSelection.currentRelease!.artifactSha,
      publisherVerifiedDeploymentIdentity: releaseSelection.currentRelease!.deploymentIdentity,
      verificationReference: "https://certification.invalid/sfp-publisher-release/stale-selection-version",
    }),
    /SFP_RUNTIME_RELEASE_SELECTION_PREVIOUS_RELEASE_MISMATCH/,
    "a stale same-SHA selection version cannot transfer runtime authority",
  );
  await assert.rejects(
    () => selectCurrentSfpRuntimeRelease({
      actorId,
      expectedPreviousArtifactSha: releaseSelection.selectedRelease!.artifactSha,
      expectedPreviousSelectionVersion: releaseSelection.selectedRelease!.selectionVersion,
      publisherVerifiedArtifactSha: releaseSelection.currentRelease!.artifactSha,
      publisherVerifiedDeploymentIdentity: releaseSelection.currentRelease!.deploymentIdentity,
      verificationReference: "https://certification.invalid/sfp-publisher-release/already-selected",
    }),
    /SFP_RUNTIME_RELEASE_ALREADY_SELECTED/,
    "the same publisher-verified SHA and deployment cannot create a duplicate selection version",
  );
  const unchangedReleaseSelection = await getSfpRuntimeReleaseSelectionStatus();
  assert.equal(unchangedReleaseSelection.selectedRelease?.selectionVersion, 1,
    "rejected selector requests do not advance durable selection history");

  // The paid budget uses the real typed-confirmation API and the disposable
  // admin above. It is not a new provider cap or a production authority.
  const budgetAuthorization = await authorizePaidBudget({
    authorizedBy: actorId,
    typedConfirmation: MI09_PAID_BUDGET_TYPED_CONFIRMATION,
  });
  assert.equal(budgetAuthorization.authorizedBy, actorId);
  const providerControlRows = rows(await db.execute(sql`
    UPDATE provider_controls
       SET enabled=TRUE,circuit_state='closed',version=version+1,updated_at=NOW()
     WHERE provider IN ('zerobounce','outscraper','apollo')
     RETURNING provider
  `));
  assert.deepEqual(
    providerControlRows.map((item: any) => String(item.provider)).sort(),
    ["apollo", "outscraper", "zerobounce"],
    "only the three disposable provider controls needed by this suite are enabled",
  );

  const campaign = rows(await db.execute(sql`
    INSERT INTO campaigns (name,status,target_verticals,created_by,total_steps)
    VALUES (${`${runKey}-draft-campaign`},'draft',ARRAY[${vertical}],${actorId},1)
    RETURNING id,name
  `))[0];
  const sequence = rows(await db.execute(sql`
    INSERT INTO follow_up_sequences
      (name,status,trigger_type,total_steps,sequence_family,channels_allowed,eligible_consent_tiers)
    VALUES (${`${runKey}-paused-sequence`},'paused','manual',1,${`${runKey}-sequence-family`},
            ARRAY['email','task'],ARRAY['first_party_role_inbox'])
    RETURNING id,name
  `))[0];
  const packageContentHash = await computeLivePackageContentHash(
    db, Number(campaign.id), Number(sequence.id),
  );
  const packageVersion = rows(await db.execute(sql`
    INSERT INTO sfp_campaign_package_versions
      (package_key,vertical,campaign_id,campaign_name,sequence_id,sequence_name,
       sequence_family,content_hash,lifecycle_state,effective_at,actor_id)
    VALUES (${packageKey},${vertical},${Number(campaign.id)},${String(campaign.name)},
            ${Number(sequence.id)},${String(sequence.name)},${`${runKey}-sequence-family`},
            ${packageContentHash},'current',NOW(),${actorId})
    RETURNING id
  `))[0];

  const policy = rows(await db.execute(sql`
    SELECT d.id,d.document_hash,d.version
      FROM sfp_outreach_policy_control c
      JOIN sfp_outreach_policy_documents d ON d.id=c.active_policy_id
     WHERE c.singleton=TRUE
  `))[0];
  assert.ok(policy?.id, "a migrated active SFP outreach policy is required");

  const program = rows(await db.execute(sql`
    INSERT INTO sfp_programs
      (name,county_fips,vertical_ids,max_cohort_size,policy_version,is_active,created_by,
       taxonomy_version,recurring_enabled,schedule_config)
    VALUES ('south-florida-v1',ARRAY['12086'],ARRAY[${vertical}],10,
            ${Number(policy.version)},TRUE,${actorId},2,FALSE,
            '{"freeBatch":25,"paidBatch":10,"validationBatch":25,"campaignStaging":1}'::jsonb)
    ON CONFLICT (name) DO UPDATE SET
      county_fips=EXCLUDED.county_fips,vertical_ids=EXCLUDED.vertical_ids,
      max_cohort_size=EXCLUDED.max_cohort_size,policy_version=EXCLUDED.policy_version,
      is_active=TRUE,taxonomy_version=EXCLUDED.taxonomy_version,recurring_enabled=FALSE,
      schedule_config=EXCLUDED.schedule_config
    RETURNING id
  `))[0];
  assert.ok(program?.id, "the disposable canonical SFP program is active with manual campaign staging enabled");

  const businessAName = `${runKey} First Party Trades`;
  const businessBName = `${runKey} Paid Discovery Trades`;
  const businessCName = `${runKey} Contact Source Trades`;
  const businessDName = `${runKey} Shared Recipient Collision Trades`;
  const insertBusiness = async (name: string, domain: string | null) => Number(rows(await db.execute(sql`
    INSERT INTO businesses
      (canonical_name,normalized_name,vertical,state,record_class,city,postal_code,street_address,
       website_domain,main_phone,created_at)
    VALUES (${name},${name.toLowerCase()},${vertical},'FL','canonical','Miami','33130',
            '100 Test Avenue',${domain},NULL,NOW())
    RETURNING id
  `))[0].id);
  const businessA = await insertBusiness(businessAName, sharedDomain);
  const businessB = await insertBusiness(businessBName, null);
  const businessC = await insertBusiness(businessCName, contactDomain);
  const businessD = await insertBusiness(businessDName, null);
  for (const businessId of [businessA, businessB, businessC, businessD]) {
    await db.execute(sql`
      INSERT INTO business_locations
        (business_id,street_address,city,state,postal_code,county_fips,is_primary,created_at,updated_at)
      VALUES (${businessId},'100 Test Avenue','Miami','FL','33130','12086',TRUE,NOW(),NOW())
    `);
  }

  // Persist classifier evidence from the current pure classifier output and
  // geography evidence from the current deterministic resolver. The small
  // canonical business rows and location facts are explicitly disposable
  // fixtures, not assertions about any production entity.
  const cohortRunId = randomUUID();
  const cohortHash = sha256({ runKey, businessIds: [businessA, businessB, businessC, businessD] });
  const cohortResults: Array<{ businessId: number; name: string; result: any; evidenceId: string }> = [];
  for (const [businessId, name] of [
    [businessA, businessAName],
    [businessB, businessBName],
    [businessC, businessCName],
    [businessD, businessDName],
  ] as const) {
    const classification = classifyVertical(vertical, [vertical], 2);
    assert.equal(classification.outcome, "resolved_high");
    assert.equal(classification.matchedTargetId, vertical);
    const geography = resolveGeographyFromCandidates([{
      locationId: null,
      isPrimary: true,
      city: "Miami",
      state: "FL",
      postalCode: "33130",
      countyFips: "12086",
    }]);
    assert.equal(geography.outcome, "resolved");
    assert.equal(geography.countyFips, "12086");
    const evidence = rows(await db.execute(sql`
      INSERT INTO sfp_classification_evidence
        (business_id,evidence_hash,source_refs,classifier_version,model_version,prompt_version,
         policy_version,taxonomy_version,outcome,confidence,reason_codes,idempotency_key,
         resolved_vertical_id,admission_tier)
      VALUES (${businessId},${classification.evidenceHash},
        ${JSON.stringify({
          source: "task_2060_disposable_canonical_business_fixture",
          businessId,
          canonicalName: name,
          rawVertical: vertical,
        })}::jsonb,
        ${CLASSIFIER_VERSION},'pure-taxonomy-classifier','taxonomy-v2',1,2,'target',
        ${classification.confidence},${JSON.stringify(classification.reasons)}::jsonb,
        ${`${runKey}-classification-${businessId}`},${vertical},${classification.outcome})
      RETURNING id
    `))[0];
    cohortResults.push({
      businessId,
      name,
      result: { classification, geography },
      evidenceId: String(evidence.id),
    });
  }

  await db.execute(sql`
    INSERT INTO sfp_cohort_runs
      (id,program_id,idempotency_key,status,cohort_size,cohort_hash,release_sha,actor_id,
       cohort_state,frozen_at,request_hash,config_hash)
    VALUES (${cohortRunId}::uuid,${String(program.id)},${`${runKey}-cohort`},
      'freezing',4,${cohortHash},${"a".repeat(40)},${actorId},'freezing',NULL,${cohortHash},${cohortHash})
  `);
  for (const entry of cohortResults) {
    const classification = entry.result.classification;
    const geography = entry.result.geography;
    await db.execute(sql`
      INSERT INTO sfp_cohort_members
        (cohort_run_id,business_id,roi_score,geography_class,geography_source,county_fips,vertical,
         classifier_version,classifier_outcome,classifier_confidence,classifier_matched_target,
         classifier_reasons,classifier_evidence_hash,geography_resolver_version,geography_outcome)
      VALUES (${cohortRunId}::uuid,${entry.businessId},95,'verified','fips','12086',${vertical},
        ${classification.version},'target',${classification.confidence},${classification.matchedTargetId},
        ${JSON.stringify(classification.reasons)}::jsonb,${classification.evidenceHash},
        ${geography.resolverVersion},${geography.outcome})
    `);
    await db.execute(sql`
      INSERT INTO sfp_cohort_decisions
        (cohort_run_id,business_id,disposition,geography_class,geography_source,vertical,roi_score,
         selected,classifier_version,classifier_outcome,classifier_confidence,classifier_matched_target,
         classifier_reasons,classifier_evidence_hash,classification_evidence_id,
         classification_policy_version,classification_evidence_hash)
      VALUES (${cohortRunId}::uuid,${entry.businessId},'selected','verified','fips',${vertical},95,
        TRUE,${classification.version},'target',${classification.confidence},${classification.matchedTargetId},
        ${JSON.stringify(classification.reasons)}::jsonb,${classification.evidenceHash},
        ${entry.evidenceId}::uuid,1,${classification.evidenceHash})
    `);
  }
  await db.execute(sql`
    UPDATE sfp_cohort_runs
       SET status='frozen',cohort_state='frozen',frozen_at=NOW()
     WHERE id=${cohortRunId}::uuid
  `);

  const testActors = rows(await db.execute(sql`
    SELECT id,role FROM users WHERE id IN (${actorId},${sourceActorId}) ORDER BY id
  `));
  assert.equal(testActors.length, 2);
  assert.ok(testActors.some((user: any) => user.id === sourceActorId && user.role === "user"));
  assert.ok(testActors.some((user: any) => user.id === actorId && user.role === "admin"));

  // Exercise named-email eligibility review through the actual admin routes.
  // This test-only identity middleware is confined to the loopback API server
  // and the private disposable database.
  const reviewApp = express();
  reviewApp.use(express.json());
  reviewApp.use((req: any, _res: any, next: () => void) => {
    req.user = { id: routeReviewerId, role: "admin" };
    req.isAuthenticated = () => true;
    next();
  });
  registerLeadOpsRoutes(reviewApp);
  reviewApiServer = reviewApp.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    reviewApiServer.once("listening", resolve);
    reviewApiServer.once("error", reject);
  });
  reviewApiBaseUrl = `http://127.0.0.1:${reviewApiServer.address().port}`;

  // Create authentic contact evidence through the canonical writer. The
  // independent admin approval below is exercised through the real
  // commercial-link authority using a different persisted test user.
  const contactWrite = await writeContact({
    mode: "local_only",
    mutation: {
      firstName: "Casey",
      lastName: "Trades",
      email: contactEmail,
      phone: "3055550199",
      companyName: businessCName,
      status: "New",
    },
    provenance: {
      sourceCategory: "discovery",
      sourceType: "cro03",
      eventKey: `${runKey}-contact-source-event`,
      actorType: "user",
      actorId: sourceActorId,
      metadata: { testScope: "task2060_disposable_only" },
    },
    actor: { actorType: "user", actorId: sourceActorId },
    hookPolicy: {
      source: "cro03",
      deferValidation: true,
      deferReadiness: true,
      deferLeadScoring: true,
      suppressProviderProjection: true,
    },
  });
  const contactId = Number(contactWrite.id);
  const sourceEventId = Number(contactWrite._sourceEventId);
  assert.ok(contactId > 0 && sourceEventId > 0);
  const linkCandidate = await recordContactBusinessLinkCandidate({
    contactId,
    businessId: businessC,
    source: "legacy_import",
    sourceVersion: "task-2060-disposable-canonical-writer",
    candidateKey: `${runKey}-contact-business-candidate`,
    confidence: 91,
  });
  assert.ok(linkCandidate?.id, "the unapproved contact-business candidate is review-only");
  const approvedContactLink = await decideContactBusinessLink({
    contactId,
    businessId: businessC,
    decision: "verified",
    decisionKey: `${runKey}-independent-contact-link-review`,
    reviewerId: actorId,
    evidenceSourceEventId: sourceEventId,
    expectedRevision: 0,
  });
  assert.equal(approvedContactLink.decision, "verified");
  assert.notEqual(sourceActorId, actorId, "independent disposable link reviewer is distinct from source owner");

  const freeGeneration = await createFreeDiscoveryGeneration({
    runKey: `${runKey}-free-discovery`,
    actorId,
    reason: "Task 2060 deterministic first-party role-inbox fixture; disposable database only.",
    purpose: "email_discovery",
  });
  const freeCandidate = await recordFreeDiscoveryCandidate({
    generationId: freeGeneration.id,
    businessId: businessA,
    domain: sharedDomain,
    source: "first_party_contact_page",
    attributionScope: "role",
    subjectType: "business",
    email: sharedEmail,
    confidence: 92,
  });
  await completeFreeDiscoveryGeneration(freeGeneration.id);
  assert.ok(freeCandidate.id);
  const duplicateFreeGeneration = await createFreeDiscoveryGeneration({
    runKey: `${runKey}-duplicate-free-discovery`,
    actorId,
    reason: "Task 2060 same-recipient collision fixture for the independent disposable business.",
    purpose: "email_discovery",
  });
  const duplicateFreeCandidate = await recordFreeDiscoveryCandidate({
    generationId: duplicateFreeGeneration.id,
    businessId: businessD,
    domain: sharedDomain,
    source: "first_party_contact_page",
    attributionScope: "role",
    subjectType: "business",
    email: sharedEmail,
    confidence: 92,
  });
  await completeFreeDiscoveryGeneration(duplicateFreeGeneration.id);
  assert.ok(duplicateFreeCandidate.id);

  // Provider results arrive through the actual governed OutScraper call.
  // These fixtures follow the provider's documented business-result shape,
  // with no task IDs so the adapter parses each completed result synchronously.
  const paidPreview = await previewSfpPaidWaterfall(cohortRunId);
  const gapSnapshot = await getSfpCohortGapSnapshot(cohortRunId);
  assert.ok(paidPreview.programActive && gapSnapshot.snapshotHash);
  let outScraperCalls = 0;
  const outScraperFixture = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : (input as Request).url);
    if (url.origin !== "https://api.outscraper.com" || url.pathname !== "/maps/search") {
      throw new Error(`TASK_2060_UNEXPECTED_OUTSCRAPER_URL:${url.origin}${url.pathname}`);
    }
    if (new Headers(init?.headers).get("X-API-KEY") !== process.env.OUTSCRAPER_API_KEY) {
      throw new Error("TASK_2060_FAKE_OUTSCRAPER_KEY_MISMATCH");
    }
    const query = url.searchParams.get("query") ?? "";
    const isPaidTarget = query.includes(businessBName) || query.includes(businessDName);
    assert.ok(isPaidTarget, "paid provider fixture is scoped to one of the two frozen discovery targets");
    outScraperCalls++;
    const isBusinessB = query.includes(businessBName);
    const fixtureName = isBusinessB ? businessBName : businessDName;
    const fixtureBusinessId = isBusinessB ? businessB : businessD;
    return new Response(JSON.stringify({
      data: [[{
        name: fixtureName,
        phone: isBusinessB ? "3055550188" : "3055550189",
        ...(isBusinessB ? { email: paidEmail } : {}),
        website: `https://${isBusinessB ? paidDomain : `${runKey.slice(-12)}.duplicate.example`}`,
        address: "100 Test Avenue",
        city: "Miami",
        state: "FL",
        postal_code: "33130",
        category: "Construction company",
        place_id: `task2060-place-${fixtureBusinessId}`,
      }]],
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": `${runKey}-outscraper-request-${fixtureBusinessId}`,
      },
    });
  };
  const paidDiscovery = await executeSfpPaidPersonAndIdentityDiscovery({
    cohortRunId,
    idempotencyKey: `${runKey}-paid-waterfall`,
    actorId,
    maxBusinesses: 2,
    previewSnapshotHash: gapSnapshot.snapshotHash,
    includeSerperDiscovery: false,
    enabledProviders: ["outscraper"],
  }, { fetchImpl: outScraperFixture as typeof fetch });
  assert.equal(outScraperCalls, 2, "both frozen paid-discovery targets receive deterministic provider results");
  assert.equal(paidDiscovery.processed, 2);
  assert.equal(paidDiscovery.providerRequests, 2);
  assert.equal(paidDiscovery.succeeded, 2);
  assert.equal(paidDiscovery.zeroOutreachConfirmed, true);
  const paidEvidence = rows(await db.execute(sql`
    SELECT id,provider,field,subject_type,disposition,normalized_value_hash,masked_value
      FROM sfp_paid_candidate_evidence
     WHERE business_id=${businessB} AND provider='outscraper'
     ORDER BY created_at DESC LIMIT 5
  `));
  assert.ok(paidEvidence.some((item: any) =>
    item.field === "email" && item.subject_type === "business" && item.disposition === "staged"),
  "paid provider email is retained as separate typed SFP evidence");

  // Validation is performed with a fresh preview and real provider-operation
  // reservation/dispatch/settlement; `zbTransport` is deliberately not used.
  const validationPreview = await previewSfpValidation(cohortRunId);
  assert.equal(validationPreview.gateOpen, true);
  const providerFailureCodes: string[] = [];
  const validation = await executeSfpValidation(cohortRunId, {
    idempotencyKey: `${runKey}-validation`,
    actorId,
    maxValidations: 25,
    snapshotHash: validationPreview.snapshotHash,
    onProviderFailureDiagnostic: (phase, safeCode) => providerFailureCodes.push(`${phase}:${safeCode}`),
  });
  const validationDiagnostics = rows(await db.execute(sql`
    SELECT e.business_id,e.status,e.zb_outcome,e.decision_reason,e.reason_codes,
           e.validation_operation_id,
           o.state AS operation_state,a.outcome AS attempt_outcome,a.error_code
      FROM sfp_outreach_eligibility e
      LEFT JOIN provider_operations o ON o.id=e.validation_operation_id
      LEFT JOIN provider_attempts a ON a.operation_id=o.id AND a.attempt_number=1
     WHERE cohort_run_id=${cohortRunId}::uuid
     ORDER BY e.business_id
  `));
  const validationProviderOperations = rows(await db.execute(sql`
    SELECT o.id,o.provider,o.purpose,o.operation_type,o.state,o.billing_state,o.failure_code,
           o.requested_units,o.reserved_units,o.settled_units,o.attempt_count,o.runtime_owner_epoch,
           (o.runtime_owner_token IS NOT NULL) AS has_runtime_owner_binding,
           a.attempt_number,a.outcome AS attempt_outcome,a.retryable AS attempt_retryable,
           a.safe_http_class,a.error_code AS attempt_error_code,
           (a.dispatch_marked_at IS NOT NULL) AS dispatch_marked,
           l.owner_epoch AS lease_owner_epoch,
           (l.operation_id IS NOT NULL) AS job_lease_present,
           (l.owner_epoch=o.runtime_owner_epoch AND l.owner_token=o.runtime_owner_token)
             AS lease_matches_operation,
           (l.lease_expires_at>NOW() AND l.revoked_at IS NULL) AS lease_live,
           c.enabled AS control_enabled,c.circuit_state,c.reserved_units AS control_reserved_units,
           c.consumed_units AS control_consumed_units,
           po.outcome AS observation_outcome,po.retryable AS observation_retryable
      FROM provider_operations o
      LEFT JOIN provider_attempts a ON a.operation_id=o.id
      LEFT JOIN sfp_runtime_job_leases l ON l.operation_id=o.id
      LEFT JOIN provider_controls c ON c.provider=o.provider
      LEFT JOIN LATERAL (
        SELECT outcome,retryable
          FROM provider_observations
         WHERE operation_id=o.id
         ORDER BY observed_at DESC
         LIMIT 1
      ) po ON TRUE
     WHERE o.provider='zerobounce'
       AND o.idempotency_key LIKE ${`${runKey}-validation:zerobounce:%`}
     ORDER BY o.created_at,o.id,a.attempt_number
  `));
  const safeValidationDiagnostics = validationDiagnostics.map((item: any) => ({
    businessId: Number(item.business_id),
    status: safeProviderDiagnosticCode(item.status),
    outcome: safeProviderDiagnosticCode(item.zb_outcome),
    decisionReason: safeProviderDiagnosticCode(item.decision_reason),
    reasonCodes: Array.isArray(item.reason_codes)
      ? item.reason_codes.map(safeProviderDiagnosticCode)
      : [],
    operationId: item.validation_operation_id == null ? null : String(item.validation_operation_id),
    operationState: safeProviderDiagnosticCode(item.operation_state),
    attemptOutcome: safeProviderDiagnosticCode(item.attempt_outcome),
    attemptErrorCode: safeProviderDiagnosticCode(item.error_code),
  }));
  const safeValidationProviderOperations = validationProviderOperations.map((operation: any) => ({
    id: String(operation.id),
    provider: safeProviderDiagnosticCode(operation.provider),
    purpose: safeProviderDiagnosticCode(operation.purpose),
    operationType: safeProviderDiagnosticCode(operation.operation_type),
    state: safeProviderDiagnosticCode(operation.state),
    billingState: safeProviderDiagnosticCode(operation.billing_state),
    failureCode: safeProviderDiagnosticCode(operation.failure_code),
    requestedUnits: Number(operation.requested_units),
    reservedUnits: Number(operation.reserved_units),
    settledUnits: Number(operation.settled_units),
    attemptCount: Number(operation.attempt_count),
    ownerEpoch: operation.runtime_owner_epoch == null ? null : Number(operation.runtime_owner_epoch),
    hasRuntimeOwnerBinding: operation.has_runtime_owner_binding === true,
    attemptNumber: operation.attempt_number == null ? null : Number(operation.attempt_number),
    attemptOutcome: safeProviderDiagnosticCode(operation.attempt_outcome),
    attemptRetryable: operation.attempt_retryable == null ? null : operation.attempt_retryable === true,
    safeHttpClass: safeProviderDiagnosticCode(operation.safe_http_class),
    attemptErrorCode: safeProviderDiagnosticCode(operation.attempt_error_code),
    dispatchMarked: operation.dispatch_marked === true,
    jobLeasePresent: operation.job_lease_present === true,
    leaseOwnerEpoch: operation.lease_owner_epoch == null ? null : Number(operation.lease_owner_epoch),
    leaseMatchesOperation: operation.lease_matches_operation === true,
    leaseLive: operation.lease_live === true,
    controlEnabled: operation.control_enabled === true,
    circuitState: safeProviderDiagnosticCode(operation.circuit_state),
    controlReservedUnits: Number(operation.control_reserved_units ?? 0),
    controlConsumedUnits: Number(operation.control_consumed_units ?? 0),
    observationOutcome: safeProviderDiagnosticCode(operation.observation_outcome),
    observationRetryable: operation.observation_retryable == null ? null : operation.observation_retryable === true,
  }));
  const validationFailureDiagnostic = {
    validation,
    fakeTransportCalls: zeroBounceCalls,
    caughtProviderFailureCodes: providerFailureCodes,
    eligibilities: safeValidationDiagnostics,
    providerOperations: safeValidationProviderOperations,
  };
  assert.equal(validation.failedCount, 0,
    `validation should complete all four injected responses: ${JSON.stringify(validationFailureDiagnostic)}`);
  assert.equal(validation.invalidCount, 0);
  assert.equal(zeroBounceCalls, 4, "all four source candidates traverse the fake ZeroBounce network callback");

  // Legacy projection time could extend eligibility past its immutable
  // receipt's TTL. Revisit that exact completed candidate through the normal
  // preview/validate path, without another provider request or receipt write.
  const repairOriginalReceipt = rows(await db.execute(sql`
    SELECT po.operation_id,md5(row_to_json(po)::text) AS fingerprint
      FROM sfp_outreach_eligibility e
      JOIN provider_observations po ON po.operation_id=e.validation_operation_id
     WHERE e.cohort_run_id=${cohortRunId}::uuid AND e.business_id=${businessA}
       AND po.provider='zerobounce'
  `))[0];
  assert.ok(repairOriginalReceipt);
  await db.execute(sql`
    UPDATE sfp_outreach_eligibility
       SET validation_expires_at=validation_expires_at+INTERVAL '21 seconds'
     WHERE cohort_run_id=${cohortRunId}::uuid AND business_id=${businessA}
  `);
  const repairPreview = await previewSfpValidation(cohortRunId);
  const repaired = await executeSfpValidation(cohortRunId, {
    idempotencyKey: `${runKey}-legacy-receipt-projection-repair`,
    actorId,
    maxValidations: 25,
    snapshotHash: repairPreview.snapshotHash,
  });
  assert.equal(repaired.failedCount, 0);
  assert.equal(repaired.validCount, 1, "only the malformed exact source is revisited");
  assert.equal(repaired.providerRequests, 0, "repair reuses the genuine same-business/address receipt");
  assert.equal(zeroBounceCalls, 4);
  const repairedProjection = rows(await db.execute(sql`
    SELECT e.status,COALESCE(e.validation_operation_id,e.reused_from_operation_id) AS operation_id,
           e.validation_at BETWEEN po.observed_at-INTERVAL '5 minutes'
                               AND po.observed_at+INTERVAL '5 minutes' AS time_aligned,
           e.validation_expires_at<=COALESCE(po.expires_at,po.observed_at+INTERVAL '180 days') AS expiry_bounded,
           md5(row_to_json(po)::text) AS fingerprint
      FROM sfp_outreach_eligibility e
      JOIN provider_observations po
        ON po.operation_id=COALESCE(e.validation_operation_id,e.reused_from_operation_id)
     WHERE e.cohort_run_id=${cohortRunId}::uuid AND e.business_id=${businessA}
       AND po.provider='zerobounce'
  `))[0];
  assert.equal(repairedProjection.status, "validated_outreach_eligible");
  assert.equal(repairedProjection.time_aligned, true);
  assert.equal(repairedProjection.expiry_bounded, true);
  assert.equal(String(repairedProjection.operation_id), String(repairOriginalReceipt.operation_id));
  assert.equal(repairedProjection.fingerprint, repairOriginalReceipt.fingerprint,
    "the complete immutable provider observation is unchanged");

  const eligibilities = rows(await db.execute(sql`
    SELECT id,business_id,source_kind,candidate_id,paid_candidate_evidence_id,contact_id,status,
           normalized_value_hash,normalized_value_hash_version,validation_at,validation_expires_at,
           validation_operation_id,reused_from_operation_id,contact_business_link_decision_id,contact_business_link_revision
      FROM sfp_outreach_eligibility
     WHERE cohort_run_id=${cohortRunId}::uuid
     ORDER BY business_id
  `));
  assert.equal(eligibilities.length, 4, "validation writes one authoritative eligibility per frozen business");
  assert.deepEqual(
    [...new Set(eligibilities.map((item: any) => String(item.source_kind)))].sort(),
    ["contact", "free", "paid"],
    "free, paid, and canonical-contact source kinds reach the same validation authority",
  );
  const contactEligibility = eligibilities.find((item: any) => item.source_kind === "contact");
  const roleInboxEligibilities = eligibilities.filter((item: any) => item.source_kind !== "contact");
  assert.equal(roleInboxEligibilities.length, 3);
  assert.ok(roleInboxEligibilities.every((item: any) => item.status === "validated_outreach_eligible"),
    `role-inbox fixture statuses must be outreach eligible: ${JSON.stringify(roleInboxEligibilities.map((item: any) => ({
      businessId: Number(item.business_id), sourceKind: item.source_kind, status: item.status,
    })))}`);
  assert.equal(contactEligibility?.status, "validated_review_required",
    "valid named contact remains held for an independent named-email eligibility review");
  assert.equal(Number(contactEligibility?.contact_id), contactId);
  assert.equal(
    String(contactEligibility?.contact_business_link_decision_id),
    String(approvedContactLink.id),
    "validated contact eligibility retains the reviewed link ID",
  );
  assert.equal(Number(contactEligibility?.contact_business_link_revision), Number(approvedContactLink.revision));
  const eligibilityForBusinessB = eligibilities.find((item: any) => Number(item.business_id) === businessB);
  const eligibilityForBusinessD = eligibilities.find((item: any) => Number(item.business_id) === businessD);
  assert.equal(eligibilities.find((item: any) => Number(item.business_id) === businessA)?.source_kind, "free");
  assert.equal(eligibilities.find((item: any) => Number(item.business_id) === businessC)?.source_kind, "contact");
  assert.equal(eligibilityForBusinessB?.source_kind, "paid");
  assert.equal(eligibilityForBusinessD?.source_kind, "free");
  assert.ok(eligibilities.every((item: any) =>
    item.normalized_value_hash && Number(item.normalized_value_hash_version) === 1 &&
    item.validation_at && item.validation_expires_at &&
    (item.validation_operation_id || item.reused_from_operation_id),
  ), "eligibilities pin versioned source identity and the original dispatched or reused validation operation");
  const businessEmailProjection = rows(await db.execute(sql`
    SELECT id,main_email,email_discovery_status
      FROM businesses
     WHERE id IN (${businessA},${businessB},${businessC},${businessD})
     ORDER BY id
  `));
  assert.equal(businessEmailProjection.length, 4);
  const expectedBusinessEmails = new Map<number, string | null>([
    [businessA, sharedEmail],
    [businessB, paidEmail],
    [businessC, null],
    [businessD, sharedEmail],
  ]);
  for (const businessRow of businessEmailProjection) {
    const businessId = Number(businessRow.id);
    assert.equal(
      businessRow.main_email == null ? null : String(businessRow.main_email),
      expectedBusinessEmails.get(businessId),
      `real successful validation projects only the eligible business-address source for business ${businessId}`,
    );
    if (businessId === businessC) {
      assert.notEqual(businessRow.email_discovery_status, "provider_valid",
        "a named person email held for independent review is not projected as a business mailbox");
    } else {
      assert.equal(businessRow.email_discovery_status, "provider_valid",
        "current eligible business-address evidence is copied through the real validation transaction");
    }
  }

  const namedPolicy = rows(await db.execute(sql`
    SELECT d.role_inbox_policy
      FROM sfp_outreach_policy_control c
      JOIN sfp_outreach_policy_documents d ON d.id=c.active_policy_id
     WHERE c.singleton=TRUE
  `))[0];
  assert.notEqual(namedPolicy?.role_inbox_policy?.named_or_unclassified_requires_review, false,
    "active policy requires review of named or unclassified email addresses");
  const preReviewStaging = await previewStagingV2({
    cohortRunId,
    eligibilityIds: eligibilities.map((item: any) => String(item.id)),
    actorId,
  });
  assert.equal(preReviewStaging.eligibleCount, 3,
    "only the three role-inbox addresses can stage before named-email review");
  assert.equal(
    preReviewStaging.rows.find((item: any) => String(item.eligibilityId) === String(contactEligibility.id))?.blockedReason,
    "named_email_requires_eligibility_review",
    "named contact remains blocked at staging until the independent policy review is recorded",
  );
  const reviewListResponse = await fetch(
    `${reviewApiBaseUrl}/api/lead-ops/sfp/named-email-eligibility-reviews?limit=50`,
  );
  const reviewListPayload = await reviewListResponse.json() as { reviews?: any[] };
  const namedReviewCandidate = reviewListPayload.reviews?.find(
    (item) => String(item.eligibility_id) === String(contactEligibility.id),
  );
  assert.ok(reviewListResponse.ok && namedReviewCandidate,
    "real admin review GET lists the current valid named-contact eligibility");
  assert.equal(namedReviewCandidate.source_kind, "contact");
  assert.ok(namedReviewCandidate.masked_email);
  assert.equal(String(namedReviewCandidate.contact_business_link_decision_id),
    String(contactEligibility.contact_business_link_decision_id));
  assert.equal(Number(namedReviewCandidate.contact_business_link_revision),
    Number(contactEligibility.contact_business_link_revision));
  assert.ok(JSON.stringify(reviewListPayload).includes(contactEmail),
    "authorized admin review GET exposes the actual address for review as required by the repair handoff");
  const namedReviewResponse = await fetch(
    `${reviewApiBaseUrl}/api/lead-ops/sfp/named-email-eligibility-reviews/${contactEligibility.id}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "approved",
        reason: "Independent admin eligibility review for disposable certification",
        expectedUpdatedAt: namedReviewCandidate.updated_at,
        idempotencyKey: `${runKey}-named-email-review`,
      }),
    },
  );
  const namedReviewPayload = await namedReviewResponse.json() as { review?: any; error?: string };
  assert.ok(namedReviewResponse.ok,
    `real admin review POST must approve the named contact: ${namedReviewPayload.error ?? "unknown error"}`);
  assert.equal(namedReviewPayload.review?.decision, "approved");
  assert.equal(namedReviewPayload.review?.reviewer_id, `admin:${routeReviewerId}`);
  assert.notEqual(namedReviewPayload.review?.reviewer_id, `admin:${actorId}`,
    "eligibility approval is recorded by an administrator independent from the validation actor");

  const validationOps = rows(await db.execute(sql`
    SELECT o.id,o.state,o.billing_state,a.outcome,a.dispatch_marked_at
      FROM provider_operations o
      JOIN provider_attempts a ON a.operation_id=o.id AND a.attempt_number=1
     WHERE o.purpose='sfp_email_validation'
       AND o.idempotency_key LIKE ${`${runKey}-validation:%`}
     ORDER BY o.id
  `));
  assert.equal(validationOps.length, 4);
  assert.ok(validationOps.every((op: any) =>
    op.state === "completed" && op.billing_state === "committed" &&
    op.outcome === "completed" && op.dispatch_marked_at,
  ), "every fake validation response keeps normal governed reserve/attempt/settle lineage");

  const stagingPreview = await previewStagingV2({
    cohortRunId,
    eligibilityIds: eligibilities.map((item: any) => String(item.id)),
    actorId,
  });
  assert.equal(stagingPreview.eligibleCount, 4,
    "the independent named-email review admits all four source candidates to package-pinned ready-held staging");
  assert.equal(
    stagingPreview.rows.find((item: any) => String(item.eligibilityId) === String(contactEligibility.id))?.eligibilityReviewId,
    String(namedReviewPayload.review.id),
    "the contact staging preview is pinned to the independent named-email review",
  );
  const staged = await executeStagingV2({
    cohortRunId,
    eligibilityIds: eligibilities.map((item: any) => String(item.id)),
    commandKey: stagingPreview.commandKey,
    snapshotHash: stagingPreview.snapshotHash,
    actorId,
    confirmPayloadHash: stagingPreview.payloadHash,
  });
  assert.ok(staged);
  const intents = rows(await db.execute(sql`
    SELECT id,business_id,eligibility_id,source_kind,candidate_id,paid_candidate_evidence_id,contact_id,
           contact_business_link_decision_id,contact_business_link_revision,package_version_id,
           package_key,state,normalized_value_hash,normalized_value_hash_version,
           recipient_commitment_id,master_lead_id
      FROM sfp_campaign_staging_intents
     WHERE cohort_run_id=${cohortRunId}::uuid
     ORDER BY business_id
  `));
  assert.equal(intents.length, 3,`one shared mailbox cannot create intents under competing businesses: ${JSON.stringify(staged)}`);
  assert.ok(intents.every((intent: any) =>
    intent.state === "ready_held" && String(intent.package_version_id) === String(packageVersion.id) &&
    intent.package_key === packageKey,
  ), "staging preserves source and exact current package pins while remaining held");
  const freeIntents = intents.filter((intent: any) => intent.source_kind === "free");
  const paidIntent = intents.find((intent: any) => intent.source_kind === "paid");
  const contactIntent = intents.find((intent: any) => intent.source_kind === "contact");
  const freeIntent = freeIntents.find((intent: any) => Number(intent.business_id) === businessA);
  const duplicateFreeIntent = freeIntents.find((intent: any) => Number(intent.business_id) === businessD);
  assert.ok(freeIntent && !duplicateFreeIntent && paidIntent && contactIntent);
  assert.deepEqual(
    intents.map((intent: any) => String(intent.source_kind)).sort(),
    ["contact", "free", "paid"],
    "the mapper persists every selected camelCase API source as the correct database source_kind",
  );
  const eligibilityById = new Map(eligibilities.map((item: any) => [String(item.id), item]));
  assert.ok(intents.every((intent: any) => {
    const source = eligibilityById.get(String(intent.eligibility_id)) as any;
    return intent.normalized_value_hash &&
      intent.normalized_value_hash === source?.normalized_value_hash &&
      Number(intent.normalized_value_hash_version) === Number(source?.normalized_value_hash_version);
  }), "free/paid/contact staging persists the exact validated hash and version, never NULL placeholders");
  assert.ok(intents.every((intent: any) => {
    if (intent.source_kind === "free") {
      return Boolean(intent.candidate_id) && intent.paid_candidate_evidence_id == null && intent.contact_id == null;
    }
    if (intent.source_kind === "paid") {
      return Boolean(intent.paid_candidate_evidence_id) && intent.candidate_id == null && intent.contact_id == null;
    }
    return intent.source_kind === "contact" && Number(intent.contact_id) === contactId &&
      Boolean(intent.contact_business_link_decision_id) && Number(intent.contact_business_link_revision) > 0;
  }), "persisted staging rows retain the matching typed source foreign key, including independent contact-link pins");
  assert.equal(String(contactIntent.contact_business_link_decision_id), String(approvedContactLink.id));
  assert.equal(Number(contactIntent.contact_business_link_revision), Number(approvedContactLink.revision));
  assert.ok(contactIntent.master_lead_id,
    "the independently reviewed named contact is projected to its separate SFP master-lead record at staging");
  const namedContactMasterLead = rows(await db.execute(sql`
    SELECT id,email,email_type,email_token_hash,email_valid,canonical_business_id,status
      FROM master_leads WHERE id=${String(contactIntent.master_lead_id)}::uuid
  `))[0];
  assert.equal(String(namedContactMasterLead.email), contactEmail);
  assert.equal(namedContactMasterLead.email_type, "person");
  assert.equal(String(namedContactMasterLead.email_token_hash), String(hashEmailToken(contactEmail)));
  assert.equal(namedContactMasterLead.email_valid, true);
  assert.equal(Number(namedContactMasterLead.canonical_business_id), businessC);
  assert.equal(namedContactMasterLead.status, "staged");
  const assertSourceOpensAs = async (
    reference: Parameters<typeof openSfpCandidatePlaintext>[0]["reference"],
    expectedEmail: string,
    expectedBusinessId: number,
  ) => {
    const matches = await db.transaction((tx) => openSfpCandidatePlaintext(
      {
        reference,
        cohortRunId,
        actorId,
        purpose: "task_2060_integrated_pipeline_source_assertion",
      },
      async (plaintext, resolved) =>
        plaintext === expectedEmail && resolved.businessId === expectedBusinessId,
      tx,
    ));
    assert.equal(matches, true, "the persisted typed source opens only its original plaintext and business identity");
  };
  await assertSourceOpensAs(
    { sourceKind: "free", freeDiscoveryCandidateId: String(freeIntent.candidate_id) },
    sharedEmail,
    businessA,
  );
  await assertSourceOpensAs(
    { sourceKind: "free", freeDiscoveryCandidateId: String(eligibilityForBusinessD.candidate_id) },
    sharedEmail,
    businessD,
  );
  await assertSourceOpensAs(
    { sourceKind: "paid", paidCandidateEvidenceId: String(paidIntent.paid_candidate_evidence_id) },
    paidEmail,
    businessB,
  );
  await assertSourceOpensAs(
    {
      sourceKind: "contact",
      contactId: String(contactIntent.contact_id),
      contactBusinessLinkDecisionId: String(contactIntent.contact_business_link_decision_id),
      contactBusinessLinkRevision: Number(contactIntent.contact_business_link_revision),
    },
    contactEmail,
    businessC,
  );

  // Reconfirm/renew the selected runtime owner through the real API. This
  // authority is independent of the older CRO03C fleet-attestation table.
  const runtimeOwner = await assertSfpRuntimeAuthority(cohortRunId);
  const ownerProof = rows(await db.execute(sql`
    SELECT deployment_identity,environment_identity,artifact_sha,queue_topology_hash,
           owner_epoch,owner_token,lease_expires_at,revoked_at
      FROM sfp_runtime_owner_authority WHERE authority_key='routine_sfp'
  `))[0];
  assert.equal(String(ownerProof.deployment_identity), runtimeOwner.deploymentIdentity);
  assert.equal(String(ownerProof.owner_token), runtimeOwner.ownerToken);
  assert.equal(runtimeOwner.deploymentIdentity, process.env.REPL_DEPLOYMENT_ID);
  assert.ok(new Date(ownerProof.lease_expires_at).getTime() > Date.now());
  const legacyAttestations = rows(await db.execute(sql`
    SELECT COUNT(*)::int AS count FROM cro03c_runtime_attestations
  `))[0];
  assert.equal(Number(legacyAttestations.count), 0, "the healthy SFP owner is not backed by fabricated legacy fleet evidence");

  // A previously staged recipient claim remains claimed when bridging is
  // held for missing pinned master-lead data. The bridge must not erase the
  // staging commitment or create a contact, committed claim, ledger, or
  // enrollment as a side effect of the held attempt.
  const beforeEnrollmentCount = Number(rows(await db.execute(sql`
    SELECT COUNT(*)::int AS count FROM sequence_enrollments
  `))[0].count);
  const freeRecipientHash = sfpRecipientIdentityHash(sharedEmail);
  const originalFreeClaim = rows(await db.execute(sql`
    SELECT id,state,committed_at,contact_id,contact_business_link_decision_id,
           staging_intent_id,business_id
      FROM sfp_recipient_address_commitments
     WHERE program_id=${String(program.id)}::uuid
       AND objective_key='sfp.initial_recipient_acquisition.v1'
       AND recipient_identity_hash=${freeRecipientHash}
  `))[0];
  assert.ok(originalFreeClaim, "staging created the original shared free-recipient claim");
  const sharedFreeClaimCount = Number(rows(await db.execute(sql`
    SELECT COUNT(*)::int AS count FROM sfp_recipient_address_commitments
     WHERE program_id=${String(program.id)}::uuid
       AND objective_key='sfp.initial_recipient_acquisition.v1'
       AND recipient_identity_hash=${freeRecipientHash}
  `))[0].count);
  assert.equal(sharedFreeClaimCount, 1,
    "the duplicate free sources share exactly one program/address commitment");
  const originalOwnerIntents = freeIntents.filter(
    (intent: any) => String(intent.id) === String(originalFreeClaim.staging_intent_id),
  );
  assert.equal(originalOwnerIntents.length, 1,
    "the persisted commitment identifies exactly one original free owner intent");
  const originalFreeIntent = originalOwnerIntents[0];
  const originalFreeBusinessId = Number(originalFreeIntent.business_id);
  const freeIntentsWithMasterLead = freeIntents.filter(
    (intent: any) => intent.master_lead_id != null && String(intent.master_lead_id) !== "",
  );
  assert.equal(freeIntentsWithMasterLead.length, 1,
    "exactly one same-recipient free intent owns the original master-lead pin");
  assert.equal(String(freeIntentsWithMasterLead[0].id), String(originalFreeIntent.id),
    "the original commitment owner is the free intent with the pinned master lead");
  assert.ok(freeIntents.every((intent: any) =>
    String(intent.recipient_commitment_id) === String(originalFreeClaim.id)),
  "the duplicate free intent aliases that exact original commitment");
  const freeMasterLeadId = String(originalFreeIntent.master_lead_id);
  assert.ok(freeMasterLeadId && freeMasterLeadId !== "null");
  assert.equal(String(originalFreeClaim.id), String(originalFreeIntent.recipient_commitment_id));
  assert.equal(String(originalFreeClaim.business_id), String(originalFreeIntent.business_id));
  assert.equal(originalFreeClaim.state, "claimed");
  assert.equal(originalFreeClaim.committed_at, null);
  await db.execute(sql`
    UPDATE sfp_campaign_staging_intents SET master_lead_id=NULL
     WHERE id=${String(originalFreeIntent.id)}::uuid
  `);
  const heldMissingMaster = await bridgeReadyHeldIntentToPausedEnrollment(String(originalFreeIntent.id), actorId);
  assert.equal(heldMissingMaster.status, "left_held");
  assert.equal(heldMissingMaster.heldReason, "recipient_assignment_not_yet_accepted",
    "a held bridge attempt does not accept or rewrite the previously staged recipient assignment");
  const heldAttemptArtifacts = rows(await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM sfp_recipient_address_commitments
        WHERE program_id=${String(program.id)}::uuid
          AND recipient_identity_hash=${freeRecipientHash}) AS claim_count,
      (SELECT id FROM sfp_recipient_address_commitments
        WHERE id=${String(originalFreeIntent.recipient_commitment_id)}::uuid
          AND program_id=${String(program.id)}::uuid
          AND recipient_identity_hash=${freeRecipientHash}) AS claim_id,
      (SELECT state FROM sfp_recipient_address_commitments
        WHERE id=${String(originalFreeIntent.recipient_commitment_id)}::uuid) AS claim_state,
      (SELECT committed_at FROM sfp_recipient_address_commitments
        WHERE id=${String(originalFreeIntent.recipient_commitment_id)}::uuid) AS committed_at,
      (SELECT contact_id FROM sfp_recipient_address_commitments
        WHERE id=${String(originalFreeIntent.recipient_commitment_id)}::uuid) AS committed_contact_id,
      (SELECT contact_business_link_decision_id FROM sfp_recipient_address_commitments
        WHERE id=${String(originalFreeIntent.recipient_commitment_id)}::uuid) AS committed_link_id,
      (SELECT COUNT(*)::int FROM sfp_ready_held_enrollments
        WHERE staging_intent_id=${String(originalFreeIntent.id)}::uuid) AS ledger_count,
      (SELECT COUNT(*)::int FROM sequence_enrollments) AS enrollment_count,
      (SELECT COUNT(*)::int FROM contacts WHERE lower(email)=lower(${sharedEmail})) AS contact_count,
      (SELECT COUNT(*)::int FROM contact_business_sfp_link_evidence
        WHERE eligibility_id=${String(originalFreeIntent.eligibility_id)}::uuid) AS typed_link_count
  `))[0];
  assert.equal(Number(heldAttemptArtifacts.claim_count), 1,
    "the original program/address claim remains the sole claim after the held bridge attempt");
  assert.equal(String(heldAttemptArtifacts.claim_id), String(originalFreeClaim.id),
    "the bridge hold preserves the exact original staging-claim ID");
  assert.equal(heldAttemptArtifacts.claim_state, "claimed");
  assert.equal(heldAttemptArtifacts.committed_at, null);
  assert.equal(heldAttemptArtifacts.committed_contact_id, null);
  assert.equal(heldAttemptArtifacts.committed_link_id, null);
  assert.equal(Number(heldAttemptArtifacts.ledger_count), 0);
  assert.equal(Number(heldAttemptArtifacts.enrollment_count), beforeEnrollmentCount);
  assert.equal(Number(heldAttemptArtifacts.contact_count), 0);
  assert.equal(Number(heldAttemptArtifacts.typed_link_count), 0);
  await db.execute(sql`
    UPDATE sfp_campaign_staging_intents SET master_lead_id=${freeMasterLeadId}::uuid
     WHERE id=${String(originalFreeIntent.id)}::uuid
  `);
  const concurrentBridge = await Promise.allSettled([
    bridgeReadyHeldIntentToPausedEnrollment(String(originalFreeIntent.id), actorId),
    bridgeReadyHeldIntentToPausedEnrollment(String(originalFreeIntent.id), actorId),
  ]);
  const concurrentCreations = concurrentBridge.filter((result: any) =>
    result.status === "fulfilled" && result.value?.status === "created");
  assert.equal(concurrentCreations.length, 1,
    "exactly one concurrent operator call creates the ready-held bridge");
  const bridgeReceipt = (concurrentCreations[0] as PromiseFulfilledResult<any>).value;
  const competingBridge = concurrentBridge.find((result) => result !== concurrentCreations[0]) as any;
  if (competingBridge.status === "fulfilled") {
    assert.equal(competingBridge.value.status, "already_bridged",
      "a concurrent call that observes the committed bridge reports already_bridged");
    assert.equal(Number(competingBridge.value.contactId), Number(bridgeReceipt.contactId));
    assert.equal(Number(competingBridge.value.sequenceEnrollmentId), Number(bridgeReceipt.sequenceEnrollmentId));
  } else {
    assert.equal(String(competingBridge.reason?.message ?? competingBridge.reason),
      "SFP_READY_HELD_CLAIM_ALREADY_ACTIVE",
      "the overlapping call may fail closed while the other call owns the live runtime job claim");
  }
  assert.ok(bridgeReceipt.contactId && bridgeReceipt.sequenceEnrollmentId);
  assert.equal(bridgeReceipt.enrollmentStatus, "paused");
  const bridgeReplay = await bridgeReadyHeldIntentToPausedEnrollment(String(originalFreeIntent.id), actorId);
  assert.equal(bridgeReplay.status, "already_bridged",
    "a replay after the successful concurrent call completes observes the committed bridge");
  assert.equal(Number(bridgeReplay.contactId), Number(bridgeReceipt.contactId));
  assert.equal(Number(bridgeReplay.sequenceEnrollmentId), Number(bridgeReceipt.sequenceEnrollmentId));
  assert.equal(bridgeReplay.enrollmentStatus, "paused");
  // Exercise the narrowly authorized projection repair against a real
  // disposable SLE/link/receipt/paused-enrollment fixture. Deliberately drift
  // only the live eligibility projection; immutable evidence stays intact.
  const repairForeignOperation = rows(await db.execute(sql`
    SELECT id FROM provider_operations
     WHERE state='completed'
       AND id<>COALESCE((SELECT validation_operation_id FROM sfp_outreach_eligibility
                          WHERE id=${String(originalFreeIntent.eligibility_id)}::uuid),gen_random_uuid())
     ORDER BY id LIMIT 1
  `))[0];
  assert.ok(repairForeignOperation, "disposable repair fixture has a distinct completed operation pin");
  const repairAlternateGeneration = await createFreeDiscoveryGeneration({
    runKey: `${runKey}-repair-alternate-address`,
    actorId,
    reason: "Disposable reconciliation fixture for a later business-role candidate.",
    purpose: "email_discovery",
  });
  const repairAlternateCandidate = await recordFreeDiscoveryCandidate({
    generationId: repairAlternateGeneration.id,
    businessId: originalFreeBusinessId,
    domain: sharedDomain,
    source: "first_party_contact_page",
    attributionScope: "role",
    subjectType: "business",
    email: `support@${sharedDomain}`,
    confidence: 92,
  });
  await completeFreeDiscoveryGeneration(repairAlternateGeneration.id);
  assert.notEqual(String(repairAlternateCandidate.id), String(originalFreeIntent.candidate_id));
  const repairBaseline = rows(await db.execute(sql`
    SELECT (SELECT COUNT(*)::int FROM provider_observations) AS observations,
           (SELECT COUNT(*)::int FROM provider_operations) AS operations,
           (SELECT COUNT(*)::int FROM contact_business_link_decisions) AS links,
           (SELECT COUNT(*)::int FROM sequence_enrollments) AS enrollments,
           (SELECT COUNT(*)::int FROM sfp_named_email_eligibility_reviews) AS reviews,
           (SELECT COUNT(*)::int FROM audit_logs) AS audits
  `))[0];
  const projectionExpiryBeforeRepair = rows(await db.execute(sql`
    SELECT validation_expires_at::text AS value FROM sfp_outreach_eligibility
     WHERE id=${String(originalFreeIntent.eligibility_id)}::uuid
  `))[0].value;
  const zeroBounceCallsBeforeRepair = zeroBounceCalls;
  await db.execute(sql`
    UPDATE sfp_outreach_eligibility
       SET source_kind='free',candidate_id=${String(repairAlternateCandidate.id)}::uuid,
           paid_candidate_evidence_id=NULL,contact_id=NULL,
           contact_business_link_decision_id=NULL,contact_business_link_revision=NULL,
           normalized_value_hash=${"f".repeat(64)},validation_operation_id=${String(repairForeignOperation.id)}::uuid,
           reused_from_operation_id=NULL,status='validated_review_required',named_contact=TRUE,role_inbox=FALSE,
           decision_reason='zb_valid:named_or_unclassified_address:operator_review_required',
           reason_codes='["zb_valid_review_required"]'::jsonb
     WHERE id=${String(originalFreeIntent.eligibility_id)}::uuid
  `);
  const { previewSfpStagedProjectionReconciliation, executeSfpStagedProjectionReconciliation } =
    await import("../server/services/cro03/sfp-staged-projection-reconciliation");
  const staleRepairPreview = await previewSfpStagedProjectionReconciliation([String(originalFreeIntent.id)]);
  const staleRepairHash = staleRepairPreview.results[0].snapshotHash;
  await db.execute(sql`
    UPDATE sfp_outreach_eligibility SET decision_reason='preview_changed_after_review'
     WHERE id=${String(originalFreeIntent.eligibility_id)}::uuid
  `);
  await assert.rejects(
    () => executeSfpStagedProjectionReconciliation({
      ids: [String(originalFreeIntent.id)],
      expectedSnapshotHashes: { [String(originalFreeIntent.id)]: staleRepairHash },
      actorId,
    }),
    /SFP_RECONCILIATION_PREVIEW_CHANGED/,
    "projection state drift after the GET preview receives a transactional 409 conflict",
  );
  await db.execute(sql`
    UPDATE sfp_outreach_eligibility
       SET decision_reason='zb_valid:named_or_unclassified_address:operator_review_required'
     WHERE id=${String(originalFreeIntent.eligibility_id)}::uuid
  `);
  const stagedRepairPreview = await previewSfpStagedProjectionReconciliation([String(originalFreeIntent.id)]);
  assert.equal(stagedRepairPreview.results[0].disposition, "candidate_restore");
  const stagedRepairedProjection = await executeSfpStagedProjectionReconciliation({
    ids: [String(originalFreeIntent.id)],
    expectedSnapshotHashes: { [String(originalFreeIntent.id)]: stagedRepairPreview.results[0].snapshotHash },
    actorId,
  });
  assert.deepEqual(stagedRepairedProjection.restoredIntentIds, [String(originalFreeIntent.id)]);
  const repairAfter = rows(await db.execute(sql`
    SELECT e.source_kind,e.candidate_id,e.paid_candidate_evidence_id,e.contact_id,
           e.contact_business_link_decision_id,e.contact_business_link_revision,
           e.normalized_value_hash,e.normalized_value_hash_version,e.validation_operation_id,
           e.reused_from_operation_id,e.validation_at::text AS validation_at,e.validation_expires_at::text AS expires_at,
           e.masked_email,
           e.status,e.named_contact,e.role_inbox,e.suppression_status,e.decision_reason,e.reason_codes,
           e.validation_expires_at<=${String(projectionExpiryBeforeRepair)}::timestamptz AS no_projection_ttl_extension,
           e.validation_expires_at<=NULLIF(i.validation_snapshot->>'validationExpiresAt','')::timestamptz
             AS within_original_snapshot_expiry,
           (SELECT po.observed_at::text FROM provider_observations po
             WHERE po.operation_id=${String(stagedRepairPreview.results[0].pins.validationOperationId)}::uuid
               AND po.provider='zerobounce' AND po.outcome='valid' AND po.retryable=FALSE
               AND po.subject_type='business' AND po.subject_id=e.business_id
             ORDER BY po.observed_at DESC LIMIT 1) AS original_observed_at,
           (SELECT fc.masked_value FROM free_discovery_candidates fc
             WHERE fc.id=${String(originalFreeIntent.candidate_id)}::uuid) AS source_masked_value
      FROM sfp_outreach_eligibility e
      JOIN sfp_campaign_staging_intents i ON i.id=${String(originalFreeIntent.id)}::uuid
     WHERE e.id=${String(originalFreeIntent.eligibility_id)}::uuid
  `))[0];
  assert.equal(repairAfter.source_kind, "free");
  assert.equal(String(repairAfter.candidate_id), String(originalFreeIntent.candidate_id));
  assert.notEqual(String(repairAlternateCandidate.id), String(originalFreeIntent.candidate_id),
    "positive regression starts with a different current candidate pin than the immutable original");
  assert.equal(repairAfter.paid_candidate_evidence_id, null);
  assert.equal(repairAfter.contact_id, null);
  assert.equal(repairAfter.contact_business_link_decision_id, null);
  assert.equal(repairAfter.contact_business_link_revision, null);
  assert.equal(String(repairAfter.normalized_value_hash), String(originalFreeIntent.normalized_value_hash));
  assert.equal(Number(repairAfter.normalized_value_hash_version), Number(originalFreeIntent.normalized_value_hash_version));
  assert.equal(String(repairAfter.validation_operation_id), String(stagedRepairPreview.results[0].pins.validationOperationId));
  assert.equal(repairAfter.reused_from_operation_id, null);
  assert.equal(repairAfter.validation_at, repairAfter.original_observed_at,
    "validation_at is restored from the original immutable observation timestamp");
  assert.equal(repairAfter.no_projection_ttl_extension, true);
  assert.equal(repairAfter.within_original_snapshot_expiry, true);
  assert.equal(repairAfter.masked_email, repairAfter.source_masked_value,
    "the original source mask is preserved rather than reconstructed");
  assert.equal(repairAfter.status, "validated_outreach_eligible");
  assert.equal(repairAfter.named_contact, false);
  assert.equal(repairAfter.role_inbox, true);
  assert.equal(repairAfter.suppression_status, "not_suppressed");
  assert.equal(repairAfter.decision_reason, "staged_projection_reconciled_from_immutable_business_role_evidence");
  assert.deepEqual(repairAfter.reason_codes, ["staged_projection_reconciled_from_immutable_business_role_evidence"]);
  const repairCountsAfter = rows(await db.execute(sql`
    SELECT (SELECT COUNT(*)::int FROM provider_observations) AS observations,
           (SELECT COUNT(*)::int FROM provider_operations) AS operations,
           (SELECT COUNT(*)::int FROM contact_business_link_decisions) AS links,
           (SELECT COUNT(*)::int FROM sequence_enrollments) AS enrollments,
           (SELECT COUNT(*)::int FROM sfp_named_email_eligibility_reviews) AS reviews,
           (SELECT COUNT(*)::int FROM audit_logs) AS audits
  `))[0];
  assert.equal(Number(repairCountsAfter.observations), Number(repairBaseline.observations));
  assert.equal(Number(repairCountsAfter.operations), Number(repairBaseline.operations));
  assert.equal(Number(repairCountsAfter.links), Number(repairBaseline.links));
  assert.equal(Number(repairCountsAfter.enrollments), Number(repairBaseline.enrollments));
  assert.equal(Number(repairCountsAfter.reviews), Number(repairBaseline.reviews));
  assert.equal(Number(repairCountsAfter.audits), Number(repairBaseline.audits) + 1,
    "repair and non-PII audit are committed atomically");
  assert.equal(zeroBounceCalls, zeroBounceCallsBeforeRepair,
    "projection reconciliation does not call ZeroBounce or any provider");
  const alreadyIntactProjection = rows(await db.execute(sql`
    SELECT updated_at::text,decision_reason,reason_codes
      FROM sfp_outreach_eligibility WHERE id=${String(originalFreeIntent.eligibility_id)}::uuid
  `))[0];
  const noOpPreview = await previewSfpStagedProjectionReconciliation([String(originalFreeIntent.id)]);
  assert.equal(noOpPreview.results[0].disposition, "no_op");
  const noOpResult = await executeSfpStagedProjectionReconciliation({
    ids: [String(originalFreeIntent.id)],
    expectedSnapshotHashes: { [String(originalFreeIntent.id)]: noOpPreview.results[0].snapshotHash },
    actorId,
  });
  assert.deepEqual(noOpResult.noOpIntentIds, [String(originalFreeIntent.id)]);
  const afterNoOpProjection = rows(await db.execute(sql`
    SELECT updated_at::text,decision_reason,reason_codes
      FROM sfp_outreach_eligibility WHERE id=${String(originalFreeIntent.eligibility_id)}::uuid
  `))[0];
  assert.deepEqual(afterNoOpProjection, alreadyIntactProjection,
    "already-intact projection is audited as a no-op without rewriting timestamps or decision reasons");
  const auditsAfterNoOp = Number(rows(await db.execute(sql`
    SELECT COUNT(*)::int AS count FROM audit_logs
  `))[0].count);
  assert.equal(auditsAfterNoOp, Number(repairBaseline.audits) + 2,
    "the no-op execution is also auditable without touching the projection");
  const intactValidationFields = rows(await db.execute(sql`
    SELECT zb_outcome,raw_provider_status,suppression_status
      FROM sfp_outreach_eligibility WHERE id=${String(originalFreeIntent.eligibility_id)}::uuid
  `))[0];
  for (const restrictive of [
    { reason: "zb_do_not_mail:not_deliverable_per_policy", outcome: "do_not_mail", raw: "unsafe" },
    { reason: "precheck_no_mx:authoritative_ineligible:zero_provider_spend", outcome: "valid", raw: "valid" },
  ]) {
    await db.execute(sql`
      UPDATE sfp_outreach_eligibility SET status='invalid',
        decision_reason=${restrictive.reason},zb_outcome=${restrictive.outcome},
        raw_provider_status=${restrictive.raw}
       WHERE id=${String(originalFreeIntent.eligibility_id)}::uuid
    `);
    const deniedPreview = await previewSfpStagedProjectionReconciliation([String(originalFreeIntent.id)]);
    assert.equal(deniedPreview.results[0].disposition, "rejected");
    await assert.rejects(() => executeSfpStagedProjectionReconciliation({
      ids: [String(originalFreeIntent.id)],
      expectedSnapshotHashes: { [String(originalFreeIntent.id)]: deniedPreview.results[0].snapshotHash },
      actorId,
    }), /SFP_RECONCILIATION_REJECTED/);
    const restrictiveAfter = rows(await db.execute(sql`
      SELECT status,zb_outcome,raw_provider_status FROM sfp_outreach_eligibility
       WHERE id=${String(originalFreeIntent.eligibility_id)}::uuid
    `))[0];
    assert.equal(restrictiveAfter.status, "invalid");
    assert.equal(restrictiveAfter.zb_outcome, restrictive.outcome);
    assert.equal(restrictiveAfter.raw_provider_status, restrictive.raw);
  }
  // Restore only this disposable fixture's saved provider facts, then test
  // contact-source drift separately from alternate-candidate drift.
  await db.execute(sql`
    UPDATE sfp_outreach_eligibility e SET source_kind='contact',candidate_id=NULL,
      contact_id=${Number(bridgeReceipt.contactId)},
      contact_business_link_decision_id=le.contact_business_link_decision_id,
      contact_business_link_revision=le.contact_business_link_revision,
      status='validated_review_required',named_contact=TRUE,role_inbox=FALSE,
      decision_reason='zb_valid:named_or_unclassified_address:operator_review_required',
      reason_codes='["zb_valid_review_required"]'::jsonb,
      zb_outcome=${intactValidationFields.zb_outcome},
      raw_provider_status=${intactValidationFields.raw_provider_status},
      suppression_status=${intactValidationFields.suppression_status}
     FROM sfp_ready_held_enrollments le
     WHERE e.id=${String(originalFreeIntent.eligibility_id)}::uuid
       AND le.staging_intent_id=${String(originalFreeIntent.id)}::uuid
  `);
  const contactRepairPreview = await previewSfpStagedProjectionReconciliation([String(originalFreeIntent.id)]);
  assert.equal(contactRepairPreview.results[0].disposition, "candidate_restore");
  const contactRepairResult = await executeSfpStagedProjectionReconciliation({
    ids: [String(originalFreeIntent.id)],
    expectedSnapshotHashes: { [String(originalFreeIntent.id)]: contactRepairPreview.results[0].snapshotHash },
    actorId,
  });
  assert.deepEqual(contactRepairResult.restoredIntentIds, [String(originalFreeIntent.id)]);
  assert.equal(zeroBounceCalls, zeroBounceCallsBeforeRepair);
  const committedAssignment = rows(await db.execute(sql`
    SELECT l.id AS ledger_id,l.recipient_commitment_id,l.sequence_enrollment_id,
           l.contact_business_link_decision_id,l.contact_business_link_revision,
           e.id AS enrollment_id,e.contact_id,e.status AS enrollment_status,
           c.id AS commitment_id,c.state AS commitment_state,c.committed_at,
           c.contact_id AS committed_contact_id,
           c.contact_business_link_decision_id AS committed_link_id
      FROM sfp_ready_held_enrollments l
      JOIN sequence_enrollments e ON e.id=l.sequence_enrollment_id
      JOIN sfp_recipient_address_commitments c ON c.id=l.recipient_commitment_id
     WHERE l.staging_intent_id=${String(originalFreeIntent.id)}::uuid
  `))[0];
  assert.ok(committedAssignment, "the completed bridge has one ledger-linked enrollment and commitment");
  assert.equal(String(committedAssignment.recipient_commitment_id), String(originalFreeIntent.recipient_commitment_id),
    "the bridge commits the exact original staging commitment");
  assert.equal(String(committedAssignment.commitment_id), String(originalFreeIntent.recipient_commitment_id));
  assert.equal(committedAssignment.commitment_state, "committed");
  assert.ok(committedAssignment.committed_at);
  assert.equal(Number(committedAssignment.contact_id), Number(bridgeReceipt.contactId));
  assert.equal(Number(committedAssignment.committed_contact_id), Number(bridgeReceipt.contactId));
  assert.equal(String(committedAssignment.enrollment_id), String(bridgeReceipt.sequenceEnrollmentId));
  assert.equal(String(committedAssignment.sequence_enrollment_id), String(bridgeReceipt.sequenceEnrollmentId));
  assert.equal(committedAssignment.enrollment_status, "paused");
  assert.equal(String(committedAssignment.committed_link_id),
    String(committedAssignment.contact_business_link_decision_id));
  const pausedAssignmentCounts = rows(await db.execute(sql`
    SELECT COUNT(DISTINCT l.id)::int AS ledger_count,
           COUNT(DISTINCT e.id)::int AS enrollment_count,
           COUNT(DISTINCT e.id) FILTER (WHERE e.status='paused')::int AS paused_enrollment_count
      FROM sfp_ready_held_enrollments l
      JOIN sequence_enrollments e ON e.id=l.sequence_enrollment_id
     WHERE l.staging_intent_id=${String(originalFreeIntent.id)}::uuid
  `))[0];
  assert.equal(Number(pausedAssignmentCounts.ledger_count), 1,
    "a successful concurrent bridge creates exactly one success ledger");
  assert.equal(Number(pausedAssignmentCounts.enrollment_count), 1,
    "the replay does not create a duplicate sequence enrollment");
  assert.equal(Number(pausedAssignmentCounts.paused_enrollment_count), 1,
    "the sole bridged enrollment remains paused");
  const afterEnrollmentCount = Number(rows(await db.execute(sql`
    SELECT COUNT(*)::int AS count FROM sequence_enrollments
  `))[0].count);
  assert.equal(afterEnrollmentCount, beforeEnrollmentCount + 1,
    "exactly one paused enrollment is added after the concurrent call and completed replay");
  const enrollment = rows(await db.execute(sql`
    SELECT id,status,metadata FROM sequence_enrollments WHERE id=${Number(bridgeReceipt.sequenceEnrollmentId)}
  `))[0];
  assert.equal(enrollment.status, "paused");
  const systemLink = rows(await db.execute(sql`
    SELECT d.id,d.contact_id,d.business_id,d.decision,d.revision,d.reviewed_by,
           d.system_evidence_id,d.sfp_evidence_id,e.id AS evidence_id,
           e.contact_id AS evidence_contact_id,e.business_id AS evidence_business_id,
           e.eligibility_id,e.source_kind,e.free_candidate_id,e.paid_candidate_evidence_id,
           e.normalized_value_hash,e.normalized_value_hash_version,e.validation_operation_id
      FROM contact_business_link_decisions d
      LEFT JOIN contact_business_sfp_link_evidence e ON e.id=d.sfp_evidence_id
     WHERE d.contact_id=${Number(bridgeReceipt.contactId)}
       AND d.business_id=${Number(originalFreeIntent.business_id)} AND d.superseded_at IS NULL
     ORDER BY d.revision DESC LIMIT 1
  `))[0];
  assert.equal(systemLink.decision, "verified");
  assert.equal(String(systemLink.sfp_evidence_id), String(systemLink.evidence_id),
    "system bridge decision pins its evidence through the canonical sfp_evidence_id foreign key");
  assert.equal(Number(systemLink.contact_id), Number(bridgeReceipt.contactId));
  assert.equal(Number(systemLink.business_id), Number(originalFreeIntent.business_id));
  assert.equal(Number(systemLink.evidence_contact_id), Number(bridgeReceipt.contactId));
  assert.equal(Number(systemLink.evidence_business_id), Number(originalFreeIntent.business_id));
  assert.equal(String(systemLink.eligibility_id), String(originalFreeIntent.eligibility_id));
  assert.equal(systemLink.source_kind, "free");
  assert.equal(String(systemLink.free_candidate_id), String(originalFreeIntent.candidate_id));
  assert.equal(systemLink.paid_candidate_evidence_id, null);
  assert.equal(String(systemLink.normalized_value_hash), String(originalFreeIntent.normalized_value_hash));
  assert.equal(Number(systemLink.normalized_value_hash_version), Number(originalFreeIntent.normalized_value_hash_version));
  const originalOwnerEligibility = eligibilityById.get(String(originalFreeIntent.eligibility_id)) as any;
  const originalOwnerOperationId = originalOwnerEligibility?.validation_operation_id ??
    originalOwnerEligibility?.reused_from_operation_id;
  assert.ok(originalOwnerOperationId);
  assert.equal(String(systemLink.validation_operation_id), String(originalOwnerOperationId));
  assert.ok(systemLink.evidence_id, "system bridge link has source-bound SFP evidence");
  assert.equal(systemLink.reviewed_by, null, "the system link does not impersonate a human reviewer");
  assert.equal(systemLink.system_evidence_id, null, "the bridge does not fabricate a separate authority receipt");
  const bridgeLedgerCount = Number(rows(await db.execute(sql`
    SELECT COUNT(*)::int AS count FROM sfp_ready_held_enrollments
     WHERE staging_intent_id=${String(originalFreeIntent.id)}::uuid
  `))[0].count);
  assert.equal(bridgeLedgerCount, 1, "the bridge race creates one success-ledger row");
  const freeRecipientClaim = rows(await db.execute(sql`
    SELECT state,business_id,staging_intent_id,contact_id,contact_business_link_decision_id
      FROM sfp_recipient_address_commitments
     WHERE program_id=${String(program.id)}::uuid
       AND recipient_identity_hash=${freeRecipientHash}
  `))[0];
  assert.equal(freeRecipientClaim.state, "committed");
  assert.equal(String(freeRecipientClaim.business_id), String(originalFreeIntent.business_id));
  assert.equal(String(freeRecipientClaim.staging_intent_id), String(originalFreeIntent.id));
  assert.ok(freeRecipientClaim.contact_id && freeRecipientClaim.contact_business_link_decision_id);

  // Provider observations and their provider-operation lineage are immutable.
  // Confirm their canonical trigger rejects an attempted mutation, then
  // exercise freshness using only the mutable eligibility expiry.
  const paidEligibility = eligibilityById.get(String(paidIntent.eligibility_id)) as any;
  const originalReceipt = rows(await db.execute(sql`
    SELECT id,operation_id,provider,outcome,retryable,subject_type,subject_id,email_token_hash,
           observed_at,expires_at
      FROM provider_observations
     WHERE operation_id=${String(paidEligibility.validation_operation_id)}::uuid
       AND provider='zerobounce' AND outcome='valid' AND retryable=FALSE
       AND subject_type='business' AND subject_id=${businessB}
       AND email_token_hash=${hashEmailToken(paidEmail)}
     ORDER BY observed_at DESC LIMIT 1
  `))[0];
  assert.ok(originalReceipt?.id, "the eligibility pins a real original provider observation");
  assert.equal(String(originalReceipt.operation_id), String(paidEligibility.validation_operation_id));
  assert.equal(originalReceipt.provider, "zerobounce");
  assert.equal(originalReceipt.outcome, "valid");
  assert.equal(originalReceipt.retryable, false);
  assert.equal(originalReceipt.subject_type, "business");
  assert.equal(Number(originalReceipt.subject_id), businessB);
  assert.equal(String(originalReceipt.email_token_hash), String(hashEmailToken(paidEmail)));
  const originalOperation = rows(await db.execute(sql`
    SELECT id,provider,purpose,state,billing_state,requested_units,reserved_units,settled_units,
           attempt_count,actor_id
      FROM provider_operations
     WHERE id=${String(paidEligibility.validation_operation_id)}::uuid
  `))[0];
  assert.ok(originalOperation?.id);
  assert.equal(originalOperation.provider, "zerobounce");
  assert.equal(originalOperation.purpose, "sfp_email_validation");
  const originalPaidEligibility = rows(await db.execute(sql`
    SELECT source_kind,candidate_id,paid_candidate_evidence_id,contact_id,
           normalized_value_hash,normalized_value_hash_version,validation_operation_id,
           status,zb_outcome,validation_at,validation_expires_at,updated_at
      FROM sfp_outreach_eligibility
     WHERE id=${String(paidIntent.eligibility_id)}::uuid
  `))[0];
  assert.equal(originalPaidEligibility.source_kind, "paid");
  assert.equal(originalPaidEligibility.candidate_id, null);
  assert.equal(String(originalPaidEligibility.paid_candidate_evidence_id),
    String(paidIntent.paid_candidate_evidence_id));
  assert.equal(originalPaidEligibility.contact_id, null);
  assert.equal(String(originalPaidEligibility.normalized_value_hash), String(paidIntent.normalized_value_hash));
  assert.equal(Number(originalPaidEligibility.normalized_value_hash_version), 1);
  assert.equal(String(originalPaidEligibility.validation_operation_id), String(originalOperation.id));
  assert.equal(originalPaidEligibility.status, "validated_outreach_eligible");
  assert.equal(originalPaidEligibility.zb_outcome, "valid");
  assert.ok(new Date(originalPaidEligibility.validation_expires_at).getTime() > Date.now());

  await assert.rejects(
    () => db.execute(sql`
      UPDATE provider_observations
         SET observed_at=NOW()-INTERVAL '400 days',expires_at=NOW()-INTERVAL '1 day'
       WHERE id=${String(originalReceipt.id)}::uuid
    `),
    (error: any) => /provider_observations is append-only/i.test(
      `${String(error?.message ?? error)} ${String(error?.cause?.message ?? "")}`,
    ),
    "the canonical append-only trigger rejects attempts to rewrite provider observation timestamps",
  );
  const receiptAfterRejectedMutation = rows(await db.execute(sql`
    SELECT id,operation_id,provider,outcome,retryable,subject_type,subject_id,email_token_hash,
           observed_at,expires_at
      FROM provider_observations WHERE id=${String(originalReceipt.id)}::uuid
  `))[0];
  assert.deepEqual(receiptAfterRejectedMutation, originalReceipt,
    "a rejected mutation leaves the immutable provider observation byte-for-byte unchanged");
  const operationAfterRejectedMutation = rows(await db.execute(sql`
    SELECT id,provider,purpose,state,billing_state,requested_units,reserved_units,settled_units,
           attempt_count,actor_id
      FROM provider_operations WHERE id=${String(originalOperation.id)}::uuid
  `))[0];
  assert.deepEqual(operationAfterRejectedMutation, originalOperation,
    "the immutable provider operation remains unchanged as well");

  const historyBeforeEligibilityExpiry = rows(await db.execute(sql`
    SELECT (SELECT COUNT(*)::int FROM contacts) AS contact_count,
           (SELECT COUNT(*)::int FROM sequence_enrollments) AS enrollment_count,
           (SELECT COUNT(*)::int FROM provider_observations) AS receipt_count,
           (SELECT COUNT(*)::int FROM contacts WHERE lower(email)=lower(${paidEmail})) AS paid_contact_count
  `))[0];
  const expiredEligibility = rows(await db.execute(sql`
    UPDATE sfp_outreach_eligibility
       SET validation_expires_at=NOW()-INTERVAL '1 second'
     WHERE id=${String(paidIntent.eligibility_id)}::uuid
     RETURNING source_kind,candidate_id,paid_candidate_evidence_id,contact_id,
               normalized_value_hash,normalized_value_hash_version,validation_operation_id,
               status,zb_outcome,validation_at,validation_expires_at,updated_at
  `))[0];
  assert.ok(new Date(expiredEligibility.validation_expires_at).getTime() <= Date.now(),
    "only the mutable eligibility expiry is tightened to real-clock past");
  assert.deepEqual({
    source_kind: expiredEligibility.source_kind,
    candidate_id: expiredEligibility.candidate_id,
    paid_candidate_evidence_id: expiredEligibility.paid_candidate_evidence_id,
    contact_id: expiredEligibility.contact_id,
    normalized_value_hash: expiredEligibility.normalized_value_hash,
    normalized_value_hash_version: expiredEligibility.normalized_value_hash_version,
    validation_operation_id: expiredEligibility.validation_operation_id,
    status: expiredEligibility.status,
    zb_outcome: expiredEligibility.zb_outcome,
    validation_at: expiredEligibility.validation_at,
    updated_at: expiredEligibility.updated_at,
  }, {
    source_kind: originalPaidEligibility.source_kind,
    candidate_id: originalPaidEligibility.candidate_id,
    paid_candidate_evidence_id: originalPaidEligibility.paid_candidate_evidence_id,
    contact_id: originalPaidEligibility.contact_id,
    normalized_value_hash: originalPaidEligibility.normalized_value_hash,
    normalized_value_hash_version: originalPaidEligibility.normalized_value_hash_version,
    validation_operation_id: originalPaidEligibility.validation_operation_id,
    status: originalPaidEligibility.status,
    zb_outcome: originalPaidEligibility.zb_outcome,
    validation_at: originalPaidEligibility.validation_at,
    updated_at: originalPaidEligibility.updated_at,
  }, "eligibility expiry mutation preserves source, identity, original operation, status, and validation timestamp");
  const expiredEligibilityBridge =
    await bridgeReadyHeldIntentToPausedEnrollment(String(paidIntent.id), actorId);
  assert.equal(expiredEligibilityBridge.status, "left_held");
  assert.equal(expiredEligibilityBridge.heldReason, "validation_expired_or_original_age_invalid",
    "current bridge qualification rejects the honestly expired eligibility");
  const expiredEligibilityReplay =
    await bridgeReadyHeldIntentToPausedEnrollment(String(paidIntent.id), actorId);
  assert.equal(expiredEligibilityReplay.status, "left_held");
  assert.equal(expiredEligibilityReplay.heldReason, "validation_expired_or_original_age_invalid",
    "replay remains held while the mutable eligibility expiry is past");
  const historyAfterEligibilityExpiry = rows(await db.execute(sql`
    SELECT (SELECT COUNT(*)::int FROM contacts) AS contact_count,
           (SELECT COUNT(*)::int FROM sequence_enrollments) AS enrollment_count,
           (SELECT COUNT(*)::int FROM provider_observations) AS receipt_count,
           (SELECT COUNT(*)::int FROM contacts WHERE lower(email)=lower(${paidEmail})) AS paid_contact_count
  `))[0];
  assert.deepEqual(historyAfterEligibilityExpiry, historyBeforeEligibilityExpiry,
    "held current/replay attempts leave historical contacts, enrollments, and provider receipts unchanged");
  const receiptAfterEligibilityExpiry = rows(await db.execute(sql`
    SELECT id,operation_id,provider,outcome,retryable,subject_type,subject_id,email_token_hash,
           observed_at,expires_at
      FROM provider_observations WHERE id=${String(originalReceipt.id)}::uuid
  `))[0];
  assert.deepEqual(receiptAfterEligibilityExpiry, originalReceipt,
    "honest eligibility expiry does not change the immutable provider receipt");
  const operationAfterEligibilityExpiry = rows(await db.execute(sql`
    SELECT id,provider,purpose,state,billing_state,requested_units,reserved_units,settled_units,
           attempt_count,actor_id
      FROM provider_operations WHERE id=${String(originalOperation.id)}::uuid
  `))[0];
  assert.deepEqual(operationAfterEligibilityExpiry, originalOperation,
    "honest eligibility expiry does not change provider-operation history");
  const expiredSourcePins = rows(await db.execute(sql`
    SELECT source_kind,candidate_id,paid_candidate_evidence_id,contact_id,
           normalized_value_hash,normalized_value_hash_version,validation_operation_id,
           status,zb_outcome,validation_at,validation_expires_at,updated_at
      FROM sfp_outreach_eligibility WHERE id=${String(paidIntent.eligibility_id)}::uuid
  `))[0];
  assert.deepEqual(expiredSourcePins, expiredEligibility,
    "held bridge and replay preserve all source/hash/operation pins while expiry remains past");
  await db.execute(sql`
    UPDATE sfp_outreach_eligibility
       SET validation_expires_at=${originalPaidEligibility.validation_expires_at}
     WHERE id=${String(paidIntent.eligibility_id)}::uuid
  `);
  const restoredPaidEligibility = rows(await db.execute(sql`
    SELECT source_kind,candidate_id,paid_candidate_evidence_id,contact_id,
           normalized_value_hash,normalized_value_hash_version,validation_operation_id,
           status,zb_outcome,validation_at,validation_expires_at,updated_at
      FROM sfp_outreach_eligibility WHERE id=${String(paidIntent.eligibility_id)}::uuid
  `))[0];
  assert.deepEqual(restoredPaidEligibility, originalPaidEligibility,
    "the disposable eligibility expiry is restored exactly before later bridge checks");

  const originalSequenceDescription = rows(await db.execute(sql`
    SELECT description FROM follow_up_sequences WHERE id=${Number(sequence.id)}
  `))[0];
  const driftedSequenceDescription = `${String(originalSequenceDescription?.description ?? "")} ${runKey} content drift`;
  await db.execute(sql`
    UPDATE follow_up_sequences SET description=${driftedSequenceDescription}
     WHERE id=${Number(sequence.id)}
  `);
  const driftedPackageContentHash = await computeLivePackageContentHash(
    db, Number(campaign.id), Number(sequence.id),
  );
  assert.notEqual(driftedPackageContentHash, packageContentHash,
    "the sequence description is an authoritative content field in the pinned package fingerprint");
  const enrollmentCountBeforePackageDrift = Number(rows(await db.execute(sql`
    SELECT COUNT(*)::int AS count FROM sequence_enrollments
  `))[0].count);
  const packageDriftBridge = await bridgeReadyHeldIntentToPausedEnrollment(String(paidIntent.id), actorId);
  assert.equal(packageDriftBridge.status, "left_held");
  assert.equal(packageDriftBridge.heldReason, "live_package_content_changed",
    "bridge rejects drift in an authoritative package content field");
  assert.equal(Number(rows(await db.execute(sql`
    SELECT COUNT(*)::int AS count FROM sequence_enrollments
  `))[0].count), enrollmentCountBeforePackageDrift,
  "authoritative package drift leaves enrollment history unchanged");
  await db.execute(sql`
    UPDATE follow_up_sequences SET description=${originalSequenceDescription?.description ?? null}
     WHERE id=${Number(sequence.id)}
  `);
  assert.equal(
    await computeLivePackageContentHash(db, Number(campaign.id), Number(sequence.id)),
    packageContentHash,
    "the disposable package is restored exactly after the drift check",
  );

  // The paid intent has a unique address, so its exact source/package is
  // eligible for a positive bridge after the drift checks. A missing pinned
  // master-lead reference leaves its original staging claim intact; restoring
  // that exact FK then allows the canonical claim to be committed.
  const paidRecipientHash = sfpRecipientIdentityHash(paidEmail);
  const paidMasterLeadId = String(paidIntent.master_lead_id);
  assert.ok(paidMasterLeadId && paidMasterLeadId !== "null");
  const originalPaidClaim = rows(await db.execute(sql`
    SELECT id,state,committed_at,staging_intent_id,contact_id,contact_business_link_decision_id
      FROM sfp_recipient_address_commitments
     WHERE id=${String(paidIntent.recipient_commitment_id)}::uuid
       AND program_id=${String(program.id)}::uuid
       AND recipient_identity_hash=${paidRecipientHash}
  `))[0];
  assert.ok(originalPaidClaim, "staging persists the original paid-recipient commitment");
  assert.equal(String(originalPaidClaim.staging_intent_id), String(paidIntent.id));
  assert.equal(originalPaidClaim.state, "claimed");
  assert.equal(originalPaidClaim.committed_at, null);
  await db.execute(sql`
    UPDATE sfp_campaign_staging_intents SET master_lead_id=NULL
     WHERE id=${String(paidIntent.id)}::uuid
  `);
  const paidMissingMasterHold =
    await bridgeReadyHeldIntentToPausedEnrollment(String(paidIntent.id), actorId);
  assert.equal(paidMissingMasterHold.status, "left_held");
  assert.equal(paidMissingMasterHold.heldReason, "recipient_assignment_not_yet_accepted");
  const paidClaimAfterHold = rows(await db.execute(sql`
    SELECT id,state,committed_at,staging_intent_id,contact_id,contact_business_link_decision_id
      FROM sfp_recipient_address_commitments
     WHERE program_id=${String(program.id)}::uuid
       AND recipient_identity_hash=${paidRecipientHash}
  `))[0];
  assert.equal(String(paidClaimAfterHold.id), String(originalPaidClaim.id));
  assert.equal(paidClaimAfterHold.state, "claimed");
  assert.equal(paidClaimAfterHold.committed_at, null);
  assert.equal(String(paidClaimAfterHold.staging_intent_id), String(paidIntent.id));
  assert.equal(paidClaimAfterHold.contact_id, null);
  assert.equal(paidClaimAfterHold.contact_business_link_decision_id, null,
    "the held paid bridge preserves only the staged claim without creating a committed recipient link");
  const paidLedgerAfterHold = Number(rows(await db.execute(sql`
    SELECT COUNT(*)::int AS count FROM sfp_ready_held_enrollments
     WHERE staging_intent_id=${String(paidIntent.id)}::uuid
  `))[0].count);
  assert.equal(paidLedgerAfterHold, 0, "the held paid bridge writes no success ledger");
  await db.execute(sql`
    UPDATE sfp_campaign_staging_intents SET master_lead_id=${paidMasterLeadId}::uuid
     WHERE id=${String(paidIntent.id)}::uuid
  `);
  const paidBridge = await bridgeReadyHeldIntentToPausedEnrollment(String(paidIntent.id), actorId);
  assert.equal(paidBridge.status, "created", "the paid typed source reaches a positive ready-held bridge");
  assert.equal(paidBridge.enrollmentStatus, "paused");
  const paidRecipientClaim = rows(await db.execute(sql`
    SELECT state,business_id,staging_intent_id,contact_id,contact_business_link_decision_id
      FROM sfp_recipient_address_commitments
     WHERE program_id=${String(program.id)}::uuid
       AND recipient_identity_hash=${paidRecipientHash}
  `))[0];
  assert.equal(paidRecipientClaim.state, "committed");
  assert.equal(Number(paidRecipientClaim.business_id), businessB);
  assert.equal(String(paidRecipientClaim.staging_intent_id), String(paidIntent.id));
  assert.ok(paidRecipientClaim.contact_id && paidRecipientClaim.contact_business_link_decision_id);

  const duplicateAliasIntent = freeIntents.find(
    (intent: any) => String(intent.id) !== String(originalFreeIntent.id),
  );
  assert.equal(duplicateAliasIntent,undefined,
    "competing business is held before duplicate intent/enrollment creation");

  // An existing verified decision is locked and consulted by the real bridge
  // path. Inject a transaction-local failure after that lock to verify
  // rollback, then retry the same contact intent through a positive bridge.
  await assert.rejects(
    () => bridgeReadyHeldIntentToPausedEnrollment(
      String(contactIntent.id),
      actorId,
      (stage) => {
        if (stage === "after_source_contact_locked") {
          throw new Error("TASK_2060_CONTACT_LINK_LOCK_REACHED");
        }
      },
    ),
    /TASK_2060_CONTACT_LINK_LOCK_REACHED/,
  );
  const contactLedgerAfterFault = Number(rows(await db.execute(sql`
    SELECT COUNT(*)::int AS count FROM sfp_ready_held_enrollments
     WHERE staging_intent_id=${String(contactIntent.id)}::uuid
  `))[0].count);
  assert.equal(contactLedgerAfterFault, 0, "a fault after locking the current contact decision rolls back bridge writes");
  const contactBridge = await bridgeReadyHeldIntentToPausedEnrollment(String(contactIntent.id), actorId);
  assert.equal(contactBridge.status, "created", "the contact-source intent reaches a positive ready-held bridge");
  assert.equal(contactBridge.enrollmentStatus, "paused");
  const contactRecipientClaim = rows(await db.execute(sql`
    SELECT state,business_id,staging_intent_id,contact_id,contact_business_link_decision_id
      FROM sfp_recipient_address_commitments
     WHERE program_id=${String(program.id)}::uuid
       AND recipient_identity_hash=${sfpRecipientIdentityHash(contactEmail)}
  `))[0];
  assert.equal(contactRecipientClaim.state, "committed");
  assert.equal(Number(contactRecipientClaim.business_id), businessC);
  assert.equal(String(contactRecipientClaim.staging_intent_id), String(contactIntent.id));
  assert.equal(String(contactRecipientClaim.contact_business_link_decision_id), String(approvedContactLink.id));

  // The successful free and paid bridges create canonical contacts that are
  // independently visible as alternate validation candidates. A staged
  // business must remain excluded even when those candidates have a newer
  // contact/link revision than the immutable eligibility it already owns.
  // The isolated certification runner does not execute the server-startup
  // contact-class backfill. These bridge-created contacts are genuine
  // disposable business contacts (not synthetic/test rows), so model the
  // production class that the normal startup convergence assigns before
  // testing the same unified-candidate predicates used by runtime.
  const productionBridgeContacts = rows(await db.execute(sql`
    UPDATE contacts
       SET record_class='production'
     WHERE id=ANY(ARRAY[${Number(bridgeReceipt.contactId)},${Number(paidBridge.contactId)}]::integer[])
       AND business_id=ANY(ARRAY[${originalFreeBusinessId},${businessB}]::integer[])
    RETURNING id,business_id,record_class
  `));
  assert.equal(productionBridgeContacts.length, 2,
    "the disposable free/paid bridge contacts receive their normal startup production classification");
  assert.ok(productionBridgeContacts.every((contact: any) => contact.record_class === "production") &&
    productionBridgeContacts.some((contact: any) =>
      Number(contact.id) === Number(bridgeReceipt.contactId) && Number(contact.business_id) === originalFreeBusinessId) &&
    productionBridgeContacts.some((contact: any) =>
      Number(contact.id) === Number(paidBridge.contactId) && Number(contact.business_id) === businessB),
  "only the two bridge-created contacts for their canonical test businesses are classified as production");
  const bridgedContactCandidates = await getUnifiedSfpCandidates([originalFreeBusinessId, businessB]);
  for (const [businessId, contactId] of [
    [originalFreeBusinessId, Number(bridgeReceipt.contactId)],
    [businessB, Number(paidBridge.contactId)],
  ] as const) {
    assert.ok(contactId > 0);
    assert.ok(bridgedContactCandidates.some((candidate: any) =>
      candidate.sourceKind === "contact" &&
      candidate.businessId === businessId &&
      candidate.evidenceId === `contact:${contactId}` &&
      candidate.field === "email" &&
      ["staged", "validation_admitted"].includes(candidate.disposition),
    ), `positive bridge contact ${contactId} is present as an alternate validation candidate`);
  }

  const stagedBusinessIds = [businessA, businessB, businessC, businessD];
  const stagedEligibilityPins = rows(await db.execute(sql`
    SELECT e.id,md5(row_to_json(e)::text) AS fingerprint
      FROM sfp_outreach_eligibility e
     WHERE e.cohort_run_id=${cohortRunId}::uuid
       AND e.business_id=ANY(ARRAY[${sql.join(stagedBusinessIds.map((id) => sql`${id}`), sql`, `)}]::integer[])
     ORDER BY e.business_id
  `));
  assert.equal(stagedEligibilityPins.length, 4);
  const sourceLinkProofs = rows(await db.execute(sql`
    SELECT d.id,d.contact_id,d.business_id,d.decision,d.revision,d.superseded_at,
           d.sfp_evidence_id,e.id AS evidence_id,e.eligibility_id,e.source_kind,
           e.free_candidate_id,e.paid_candidate_evidence_id,e.normalized_value_hash,
           e.normalized_value_hash_version,e.validation_operation_id,
           md5(row_to_json(d)::text) AS decision_fingerprint,
           CASE WHEN e.id IS NULL THEN NULL ELSE md5(row_to_json(e)::text) END AS evidence_fingerprint
      FROM contact_business_link_decisions d
      LEFT JOIN contact_business_sfp_link_evidence e ON e.id=d.sfp_evidence_id
     WHERE (d.contact_id=${Number(bridgeReceipt.contactId)} AND d.business_id=${originalFreeBusinessId})
        OR (d.contact_id=${Number(paidBridge.contactId)} AND d.business_id=${businessB})
        OR (d.contact_id=${Number(contactIntent.contact_id)} AND d.business_id=${businessC}
            AND d.id=${String(contactIntent.contact_business_link_decision_id)}::uuid)
     ORDER BY d.id
  `));
  assert.equal(sourceLinkProofs.length, 3,
    "each bridged/new or original contact candidate retains its source-link proof");
  assert.ok(sourceLinkProofs
    .filter((proof: any) => Number(proof.business_id) !== businessC)
    .every((proof: any) => proof.sfp_evidence_id && proof.evidence_id && proof.evidence_fingerprint),
  "the new canonical-contact alternatives are backed by immutable SFP link evidence");
  const validationReceiptFingerprints = rows(await db.execute(sql`
    SELECT e.business_id,po.operation_id,md5(row_to_json(po)::text) AS fingerprint
      FROM sfp_outreach_eligibility e
      JOIN provider_observations po
        ON po.operation_id=COALESCE(e.validation_operation_id,e.reused_from_operation_id)
       AND po.provider='zerobounce'
     WHERE e.cohort_run_id=${cohortRunId}::uuid
       AND e.business_id=ANY(ARRAY[${sql.join(stagedBusinessIds.map((id) => sql`${id}`), sql`, `)}]::integer[])
     ORDER BY e.business_id,po.operation_id
  `));
  assert.equal(validationReceiptFingerprints.length, 4,
    "all staged source eligibilities retain their original immutable ZeroBounce observation");

  const stagedCandidatePreview = await previewSfpValidation(cohortRunId);
  assert.equal(stagedCandidatePreview.gateOpen, true);
  assert.equal(stagedCandidatePreview.addressesForValidation, 1,
    "a staged primary leaves capacity for the remaining distinct alternative");
  assert.equal(stagedCandidatePreview.selectedCandidates[0].businessId,businessA);
  const alternativeSource = rows(await db.execute(sql`SELECT normalized_value_hash
    FROM free_discovery_candidates
    WHERE id=${stagedCandidatePreview.selectedCandidates[0].candidateId}::uuid`))[0];
  assert.ok(alternativeSource?.normalized_value_hash);
  assert.ok(intents.every((intent:any)=>intent.normalized_value_hash!==alternativeSource.normalized_value_hash),
    "already committed addresses are not scheduled again through another source");
  const zeroBounceCallsBeforeStagedReplay = zeroBounceCalls;
  await executeSfpValidation(cohortRunId, {
    idempotencyKey: `${runKey}-staged-alternate-candidate-regression`,
    actorId,
    maxValidations: 25,
    snapshotHash: stagedCandidatePreview.snapshotHash,
  });
  assert.equal(zeroBounceCalls, zeroBounceCallsBeforeStagedReplay+1,
    "only the distinct alternative is validated; original staged addresses are not recharged");
  const stagedEligibilityPinsAfterReplay = rows(await db.execute(sql`
    SELECT e.id,md5(row_to_json(e)::text) AS fingerprint
      FROM sfp_outreach_eligibility e
     WHERE e.cohort_run_id=${cohortRunId}::uuid
       AND e.business_id=ANY(ARRAY[${sql.join(stagedBusinessIds.map((id) => sql`${id}`), sql`, `)}]::integer[])
     ORDER BY e.business_id
  `));
  assert.deepEqual(stagedEligibilityPinsAfterReplay.filter((after:any)=>
    stagedEligibilityPins.some((before:any)=>String(before.id)===String(after.id))),stagedEligibilityPins,
    "original immutable eligibility/source pins are unchanged while a distinct alternative is validated");
  const sourceLinkProofsAfterReplay = rows(await db.execute(sql`
    SELECT d.id,d.contact_id,d.business_id,d.decision,d.revision,d.superseded_at,
           d.sfp_evidence_id,e.id AS evidence_id,e.eligibility_id,e.source_kind,
           e.free_candidate_id,e.paid_candidate_evidence_id,e.normalized_value_hash,
           e.normalized_value_hash_version,e.validation_operation_id,
           md5(row_to_json(d)::text) AS decision_fingerprint,
           CASE WHEN e.id IS NULL THEN NULL ELSE md5(row_to_json(e)::text) END AS evidence_fingerprint
      FROM contact_business_link_decisions d
      LEFT JOIN contact_business_sfp_link_evidence e ON e.id=d.sfp_evidence_id
     WHERE (d.contact_id=${Number(bridgeReceipt.contactId)} AND d.business_id=${originalFreeBusinessId})
        OR (d.contact_id=${Number(paidBridge.contactId)} AND d.business_id=${businessB})
        OR (d.contact_id=${Number(contactIntent.contact_id)} AND d.business_id=${businessC}
            AND d.id=${String(contactIntent.contact_business_link_decision_id)}::uuid)
     ORDER BY d.id
  `));
  assert.deepEqual(sourceLinkProofsAfterReplay, sourceLinkProofs,
    "the original human/system source-link proofs remain unchanged after replay");
  const validationReceiptFingerprintsAfterReplay = rows(await db.execute(sql`
    SELECT e.business_id,po.operation_id,md5(row_to_json(po)::text) AS fingerprint
      FROM sfp_outreach_eligibility e
      JOIN provider_observations po
        ON po.operation_id=COALESCE(e.validation_operation_id,e.reused_from_operation_id)
       AND po.provider='zerobounce'
     WHERE e.cohort_run_id=${cohortRunId}::uuid
       AND e.business_id=ANY(ARRAY[${sql.join(stagedBusinessIds.map((id) => sql`${id}`), sql`, `)}]::integer[])
     ORDER BY e.business_id,po.operation_id
  `));
  assert.deepEqual(validationReceiptFingerprintsAfterReplay.filter((after:any)=>
    validationReceiptFingerprints.some((before:any)=>String(before.operation_id)===String(after.operation_id))),
    validationReceiptFingerprints,
    "the original provider-observation fingerprints are unchanged after replay");

  // Revoking the human-reviewed source link after that success is visible on
  // historical replay; it never deletes or activates the paused enrollment.
  const revokedContactLink = await decideContactBusinessLink({
    contactId,
    decision: "rejected",
    decisionKey: `${runKey}-revoke-contact-source-link`,
    reviewerId: actorId,
    expectedRevision: Number(approvedContactLink.revision),
  });
  assert.equal(revokedContactLink.decision, "rejected");
  const contactBridgeReplay = await bridgeReadyHeldIntentToPausedEnrollment(String(contactIntent.id), actorId);
  assert.equal(contactBridgeReplay.status, "already_bridged");
  assert.match(String(contactBridgeReplay.currentHoldReason), /historical_contact_business_link_no_longer_current/i);

  const finalBusinessEmailProjection = rows(await db.execute(sql`
    SELECT id,main_email FROM businesses
     WHERE id IN (${businessA},${businessB},${businessC},${businessD})
  `));
  const finalBusinessEmailById = new Map(finalBusinessEmailProjection.map((item: any) =>
    [Number(item.id), item.main_email == null ? null : String(item.main_email)],
  ));
  assert.equal(finalBusinessEmailById.size, expectedBusinessEmails.size);
  for (const [businessId, expectedEmail] of expectedBusinessEmails) {
    assert.equal(finalBusinessEmailById.get(businessId), expectedEmail,
      "later eligibility, package, and contact-link holds neither clear nor re-project business email copies");
  }

  const finalEnrollmentCount = Number(rows(await db.execute(sql`
    SELECT COUNT(*)::int AS count FROM sequence_enrollments
  `))[0].count);
  assert.equal(finalEnrollmentCount, beforeEnrollmentCount + 3);
  const allEnrollments = rows(await db.execute(sql`
    SELECT se.status,s.status AS sequence_status,c.status AS campaign_status
      FROM sequence_enrollments se
      JOIN follow_up_sequences s ON s.id=se.sequence_id
      JOIN sfp_campaign_package_versions p ON p.sequence_id=s.id
      JOIN campaigns c ON c.id=p.campaign_id
  `));
  assert.equal(allEnrollments.length, 3);
  assert.ok(allEnrollments.every((row: any) =>
    row.status === "paused" && row.sequence_status === "paused" && row.campaign_status === "draft",
  ), "free, paid, and contact bridges create only paused enrollments under draft campaigns");
  const outboundPause = rows(await db.execute(sql`
    SELECT state FROM outbound_pause_control ORDER BY id LIMIT 1
  `))[0];
  assert.equal(outboundPause?.state, "paused", "the global outbound pause remains active");
  const campaignQueueCounts = rows(await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM campaign_queue_runs) AS run_count,
      (SELECT COUNT(*)::int FROM campaign_queue_items) AS item_count
  `))[0];
  assert.equal(Number(campaignQueueCounts.run_count), 0,
    "staging and bridge never create a campaign queue run");
  assert.equal(Number(campaignQueueCounts.item_count), 0,
    "staging and bridge never create a campaign queue item");

  // Exact-decimal pure contract checks include true zero and fractional units;
  // unknown and contradictory quantities remain explicit, never rounded.
  const decimalCases = [
    ["0", 0],
    ["0.5", 5_000_000],
    ["1.5", 15_000_000],
  ] as const;
  for (const [quantity, expectedMicros] of decimalCases) {
    const usage = normalizeSfpProviderUsage({
      status: "known",
      quantity,
      unit: "credit",
      providerRequestId: `${runKey}-pure-${quantity}`,
      source: "task_2060_contract_fixture",
    });
    assert.equal(usage.status, "known");
    assert.equal(usage.quantity, quantity);
    assert.equal(calculateSfpUsageCostMicros({
      usage,
      reviewedUnitPriceMicros: 10_000_000,
      reviewedUnitType: "credit",
    }), expectedMicros);
  }
  assert.equal(normalizeSfpProviderUsage({
    status: "known", quantity: "unknown", unit: "credit",
  }).status, "conflict");
  assert.equal(normalizeSfpProviderUsage({
    status: "unknown", quantity: null, unit: null,
  }).quantity, null);

  // Exercise Apollo's documented org -> people -> bulk-business-email path
  // through an actual SFP reservation and dispatch. The search endpoints
  // report exact zero credits; the enrichment endpoint reports 1.5 credits,
  // independently of the integer work reservation.
  const createAccountingStage = async (suffix: string) => {
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO sfp_stage_runs
        (id,cohort_run_id,stage,idempotency_key,actor_id,state,max_items,provider_keys,
         payload_hash,preview_snapshot_hash,started_at,last_heartbeat_at,lease_expires_at)
      VALUES (${id}::uuid,${cohortRunId}::uuid,'paid_waterfall',${`${runKey}-${suffix}`},${actorId},
        'running',1,'["apollo"]'::jsonb,${sha256(`${runKey}-${suffix}`)},${cohortHash},
        NOW(),NOW(),NOW()+INTERVAL '30 minutes')
    `);
    return id;
  };
  let apolloFixtureCalls = 0;
  const apolloFixtureReceipts: Array<{
    suffix: string;
    path: string;
    requestId: string;
    credits: string | null;
  }> = [];
  const apolloFixture = async (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    credits: string | null,
    suffix: string,
  ): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : (input as Request).url);
    if (url.origin !== "https://api.apollo.io") {
      throw new Error(`TASK_2060_UNEXPECTED_APOLLO_URL:${url.origin}${url.pathname}`);
    }
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("X-Api-Key"), process.env.APOLLO_API_KEY);
    apolloFixtureCalls++;
    const requestId = `${runKey}-${suffix}-${url.pathname.split("/").at(-1)}`;
    apolloFixtureReceipts.push({ suffix, path: url.pathname, requestId, credits });
    const body = url.pathname === "/api/v1/mixed_companies/search"
      ? {
        organizations: [{
          id: `${runKey}-organization`,
          name: businessAName,
          primary_domain: sharedDomain,
          website_url: `https://${sharedDomain}`,
          city: "Miami",
          state: "FL",
          street_address: "100 Test Avenue",
          phone: "3055550111",
          organization_id: `${runKey}-organization`,
        }],
        pagination: { total_pages: 1 },
      }
      : url.pathname === "/api/v1/mixed_people/api_search"
        ? {
          people: [{
            id: `${runKey}-person`,
            organization: { id: `${runKey}-organization` },
            first_name: "Jordan",
            last_name: "Sample",
            title: "Owner",
          }],
          pagination: { total_pages: 1 },
        }
        : url.pathname === "/api/v1/people/bulk_match"
          ? {
            matches: [{
              id: `${runKey}-person`,
              organization_id: `${runKey}-organization`,
              email: `owner@${sharedDomain}`,
              email_status: "verified",
            }],
          }
          : (() => { throw new Error(`TASK_2060_UNEXPECTED_APOLLO_PATH:${url.pathname}`); })();
    const responseBody: Record<string, unknown> = {
      ...body,
      request_id: requestId,
      ...(credits === null ? {} : { credits_consumed: credits }),
    };
    const responseHeaders: Record<string, string> = {
      "content-type": "application/json",
      "x-request-id": requestId,
    };
    if (credits !== null) responseHeaders["x-credits-used"] = credits;
    return new Response(JSON.stringify(responseBody), { status: 200, headers: responseHeaders });
  };

  const exactStageId = await createAccountingStage("apollo-exact-decimal");
  const exactReservation = await reserveSfpProviderOperation({
    stageRunId: exactStageId,
    cohortRunId,
    businessId: businessA,
    provider: "apollo",
    purpose: "sfp_named_decision_maker_discovery",
    idempotencyKey: `${runKey}-apollo-exact-decimal`,
    actorId,
    workUnit: "request",
    units: 1,
  });
  const exactApollo = await invokeSfpProviderTransport(exactReservation, () =>
    executeSfpApolloDiscovery({
      businessId: businessA,
      businessName: businessAName,
      domain: sharedDomain,
      city: "Miami",
      state: "FL",
      address: "100 Test Avenue",
      resultCap: 1,
    }, {
      fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) =>
        apolloFixture(
          input,
          init,
          new URL(typeof input === "string" || input instanceof URL ? String(input) : (input as Request).url)
            .pathname === "/api/v1/people/bulk_match" ? "1.5" : "0",
          "exact",
        )) as typeof fetch,
    }),
  );
  assert.equal(exactApollo.outcome, "success");
  assert.equal(exactApollo.people[0]?.email, `owner@${sharedDomain}`);
  const exactBulkReceipt = apolloFixtureReceipts.find((receipt) =>
    receipt.suffix === "exact" && receipt.path === "/api/v1/people/bulk_match");
  assert.ok(exactBulkReceipt, "bulk enrichment returns a real deterministic fixture receipt");
  assert.equal(exactBulkReceipt.credits, "1.5");
  const exactProviderReference = exactBulkReceipt.requestId;
  const exactSettlement = await finishSfpProviderOperation({
    reservation: exactReservation,
    outcome: "completed",
    observation: "unknown",
    businessId: businessA,
    workUnit: "request",
    workCompleted: 1,
    providerUsage: {
      status: "known", quantity: exactBulkReceipt.credits, unit: "credit",
      providerRequestId: exactProviderReference, source: "apollo_explicit_receipt",
    },
    resultData: { retrievalState: "completed" },
  });
  const exactReplay = await finishSfpProviderOperation({
    reservation: exactReservation,
    outcome: "completed",
    observation: "unknown",
    businessId: businessA,
    workUnit: "request",
    workCompleted: 1,
    providerUsage: {
      status: "known", quantity: "1.5", unit: "credit",
      providerRequestId: exactProviderReference, source: "apollo_explicit_receipt",
    },
    resultData: { retrievalState: "completed" },
  });
  assert.equal(exactSettlement.replayed, false);
  assert.equal(exactReplay.replayed, true, "exact decimal finish replay is idempotent");
  const exactOp = rows(await db.execute(sql`
    SELECT o.state,o.provider_usage_status,o.provider_usage_quantity::text AS quantity,
           o.provider_usage_unit,o.provider_request_id,o.settled_units,o.settled_cost_micros
      FROM provider_operations o WHERE o.id=${exactReservation.operationId}::uuid
  `))[0];
  assert.equal(exactOp.state, "completed");
  assert.equal(exactOp.provider_usage_status, "known");
  assert.equal(Number(exactOp.quantity), 1.5, "fractional provider credit is not truncated");
  assert.equal(exactOp.provider_usage_unit, "credit");
  assert.equal(exactOp.provider_request_id, exactProviderReference);
  assert.equal(Number(exactOp.settled_units), 1, "work units remain distinct from fractional credits");

  // Missing usage remains unknown until a real stable provider request
  // reference is reconciled. Repeating the same invoice is idempotent;
  // contradictory known values become an explicit conflict.
  const unknownStageId = await createAccountingStage("apollo-reconcile");
  const unknownReservation = await reserveSfpProviderOperation({
    stageRunId: unknownStageId,
    cohortRunId,
    businessId: businessA,
    provider: "apollo",
    purpose: "sfp_named_decision_maker_discovery",
    idempotencyKey: `${runKey}-apollo-reconcile`,
    actorId,
    workUnit: "request",
    units: 1,
  });
  const unknownApollo = await invokeSfpProviderTransport(unknownReservation, () =>
    executeSfpApolloDiscovery({
      businessId: businessA,
      businessName: businessAName,
      domain: sharedDomain,
      city: "Miami",
      state: "FL",
      address: "100 Test Avenue",
      resultCap: 1,
    }, {
      fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) =>
        apolloFixture(input, init, null, "reconcile")) as typeof fetch,
    }),
  );
  const unknownBulkReceipt = apolloFixtureReceipts.find((receipt) =>
    receipt.suffix === "reconcile" && receipt.path === "/api/v1/people/bulk_match");
  assert.ok(unknownBulkReceipt, "unknown-usage bulk response retains its stable provider request reference");
  assert.equal(unknownBulkReceipt.credits, null,
    "the unknown-usage fixture carries no fabricated provider credit quantity");
  const stableReference = unknownBulkReceipt.requestId;
  assert.ok(stableReference);
  await finishSfpProviderOperation({
    reservation: unknownReservation,
    outcome: "completed",
    observation: "unknown",
    businessId: businessA,
    workUnit: "request",
    workCompleted: 1,
    providerUsage: {
      status: "unknown", quantity: null, unit: null,
      providerRequestId: stableReference!, source: "apollo_request_receipt",
    },
    resultData: { retrievalState: "completed" },
  });
  const firstReconciliation = await reconcileSfpProviderUsage({
    provider: "apollo",
    workUnit: "request",
    providerUsage: {
      status: "known", quantity: "0.500000000000", unit: "credit",
      providerRequestId: stableReference!, source: "task_2060_documented_invoice_fixture",
    },
    reconciliationSource: "task_2060_documented_invoice_fixture",
    resultHash: sha256({ providerReference: stableReference, credits: "0.500000000000" }),
  });
  const replayReconciliation = await reconcileSfpProviderUsage({
    provider: "apollo",
    workUnit: "request",
    providerUsage: {
      status: "known", quantity: "0.5", unit: "credit",
      providerRequestId: stableReference!, source: "task_2060_documented_invoice_fixture",
    },
    reconciliationSource: "task_2060_documented_invoice_fixture",
    resultHash: sha256({ providerReference: stableReference, credits: "0.5" }),
  });
  assert.equal(firstReconciliation.status, "known");
  assert.equal(replayReconciliation.replayed, true);
  const persistedReconciliation = rows(await db.execute(sql`
    SELECT usage_quantity::text AS quantity,usage_unit,usage_status,operation_id
      FROM sfp_provider_usage_reconciliations
     WHERE provider='apollo' AND provider_request_id=${stableReference}
  `))[0];
  assert.equal(Number(persistedReconciliation.quantity), 0.5,
    "numerically equivalent invoice strings retain the same persisted exact decimal");
  assert.equal(persistedReconciliation.usage_unit, "credit");
  assert.equal(persistedReconciliation.usage_status, "known");
  assert.equal(String(persistedReconciliation.operation_id), String(unknownReservation.operationId));
  const conflictReconciliation = await reconcileSfpProviderUsage({
    provider: "apollo",
    workUnit: "request",
    providerUsage: {
      status: "known", quantity: "1.5", unit: "credit",
      providerRequestId: stableReference!, source: "task_2060_conflicting_invoice_fixture",
    },
    reconciliationSource: "task_2060_conflicting_invoice_fixture",
    resultHash: sha256({ providerReference: stableReference, credits: "1.5" }),
  });
  assert.equal(conflictReconciliation.status, "conflict");
  const reconciledOp = rows(await db.execute(sql`
    SELECT provider_usage_status,provider_usage_quantity::text AS quantity,provider_usage_unit,
           provider_request_id
      FROM provider_operations WHERE id=${unknownReservation.operationId}::uuid
  `))[0];
  assert.equal(reconciledOp.provider_usage_status, "conflict");
  assert.equal(reconciledOp.quantity, null);
  assert.equal(reconciledOp.provider_usage_unit, null);
  assert.equal(reconciledOp.provider_request_id, stableReference);
  const persistedConflict = rows(await db.execute(sql`
    SELECT usage_quantity::text AS quantity,usage_unit,usage_status
      FROM sfp_provider_usage_reconciliations
     WHERE provider='apollo' AND provider_request_id=${stableReference}
  `))[0];
  assert.equal(persistedConflict.usage_status, "conflict");
  assert.equal(persistedConflict.quantity, null);
  assert.equal(persistedConflict.usage_unit, null);

  // An expired lease cannot be heartbeated, but the selected same-release
  // runtime may make a fresh fenced claim. An already-reserved operation
  // carrying the prior epoch cannot cross dispatch after that reclaim.
  const staleStageId = await createAccountingStage("apollo-stale-owner");
  const staleReservation = await reserveSfpProviderOperation({
    stageRunId: staleStageId,
    cohortRunId,
    businessId: businessA,
    provider: "apollo",
    purpose: "sfp_named_decision_maker_discovery",
    idempotencyKey: `${runKey}-apollo-stale-owner`,
    actorId,
    workUnit: "request",
    units: 1,
  });
  const previousOwnerEpoch = staleReservation.runtimeOwnerEpoch;
  const beforeStaleDispatch = apolloFixtureCalls;
  await db.execute(sql`
    UPDATE sfp_runtime_owner_authority
       SET lease_expires_at=clock_timestamp()-INTERVAL '1 minute',updated_at=clock_timestamp()
     WHERE authority_key='routine_sfp'
  `);
  await assert.rejects(
    () => renewSfpRuntimeDeploymentOwner(),
    /SFP_RUNTIME_OWNER_FENCE_LOST/,
    "an expired owner lease cannot be heartbeat-renewed",
  );
  const reclaimedOwner = await assertSfpRuntimeAuthority(cohortRunId);
  assert.equal(reclaimedOwner.ownerEpoch, previousOwnerEpoch + 1,
    "the selected release recovers expired ownership only under a fresh epoch");
  await assert.rejects(
    () => invokeSfpProviderTransport(staleReservation, async () => {
      apolloFixtureCalls++;
      throw new Error("TASK_2060_STALE_OWNER_REACHED_TRANSPORT");
    }),
    /SFP_PROVIDER_DISPATCH_BOUNDARY_LOST|RUNTIME_OWNER|LEASE|FENCE/i,
  );
  assert.equal(apolloFixtureCalls, beforeStaleDispatch, "stale runtime owner cannot reach the provider callback");
  await assert.rejects(
    () => finishSfpProviderOperation({
      reservation: staleReservation,
      outcome: "not_dispatched",
      observation: "transport",
      businessId: businessA,
      workUnit: "request",
      workCompleted: 0,
      providerUsage: {
        status: "not_applicable", quantity: null, unit: null,
        providerRequestId: null, source: "not_dispatched",
      },
      resultData: { retrievalState: "not_dispatched" },
    }),
    /SFP_PROVIDER_SETTLEMENT_FENCE_LOST/,
    "a prior-epoch reservation cannot be settled under the newly reclaimed runtime owner",
  );
  const staleOperationAfterFenceLoss = rows(await db.execute(sql`
    SELECT o.state,o.billing_state,o.claim_token,a.dispatch_marked_at,
           EXISTS(SELECT 1 FROM provider_observations po WHERE po.operation_id=o.id) AS has_observation
      FROM provider_operations o
      JOIN provider_attempts a ON a.operation_id=o.id AND a.attempt_number=1
     WHERE o.id=${staleReservation.operationId}::uuid
  `))[0];
  assert.equal(staleOperationAfterFenceLoss.state, "running");
  assert.equal(staleOperationAfterFenceLoss.billing_state, "reserved");
  assert.equal(String(staleOperationAfterFenceLoss.claim_token), String(staleReservation.claimToken));
  assert.equal(staleOperationAfterFenceLoss.dispatch_marked_at, null);
  assert.equal(staleOperationAfterFenceLoss.has_observation, false,
    "a stale reservation remains untouched and produces no synthetic settled observation");

  // A same-SHA redeployment is a distinct authorized release tuple. Only the
  // normal selector API may transfer it; the retired deployment cannot
  // reclaim the owner even though its artifact SHA is unchanged.
  const selectedBeforeRedeploy = await getSfpRuntimeReleaseSelectionStatus();
  const retiredDeploymentIdentity = process.env.REPL_DEPLOYMENT_ID!;
  const currentArtifactSha = process.env.RELEASE_SHA!;
  const redeployedIdentity = `${retiredDeploymentIdentity}:task-2060-redeploy:${runKey.slice(-8)}`;
  process.env.REPL_DEPLOYMENT_ID = redeployedIdentity;
  const redeployedSelection = await selectCurrentSfpRuntimeRelease({
    actorId,
    expectedPreviousArtifactSha: selectedBeforeRedeploy.selectedRelease!.artifactSha,
    expectedPreviousSelectionVersion: selectedBeforeRedeploy.selectedRelease!.selectionVersion,
    publisherVerifiedArtifactSha: currentArtifactSha,
    publisherVerifiedDeploymentIdentity: redeployedIdentity,
    verificationReference: `https://certification.invalid/sfp-publisher-release/${currentArtifactSha}/redeploy`,
  });
  assert.equal(redeployedSelection.action, "transfer");
  assert.equal(redeployedSelection.selectedRelease.artifactSha, currentArtifactSha,
    "the private redeployment preserves the selected artifact SHA");
  assert.equal(redeployedSelection.selectedRelease.selectionVersion,
    selectedBeforeRedeploy.selectedRelease!.selectionVersion + 1,
    "same-SHA deployment transfer advances the selector version");
  const redeploymentSelectionEvent = rows(await db.execute(sql`
    SELECT action,actor_id,previous_selection->>'artifactSha' AS previous_artifact_sha,
           previous_selection->>'selectionVersion' AS previous_selection_version
      FROM sfp_runtime_release_selection_events
     WHERE id=${redeployedSelection.eventId}::uuid
  `))[0];
  assert.equal(redeploymentSelectionEvent.action, "transfer");
  assert.equal(redeploymentSelectionEvent.actor_id, actorId);
  assert.equal(redeploymentSelectionEvent.previous_artifact_sha, currentArtifactSha);
  assert.equal(Number(redeploymentSelectionEvent.previous_selection_version),
    selectedBeforeRedeploy.selectedRelease!.selectionVersion);
  process.env.REPL_DEPLOYMENT_ID = retiredDeploymentIdentity;
  await assert.rejects(
    () => assertSfpRuntimeAuthority(cohortRunId),
    /SFP_RUNTIME_OWNER_BLOCKED:CURRENT_RELEASE_NOT_SELECTED/,
    "the retired same-SHA deployment cannot reclaim after selector transfer",
  );
  await assert.rejects(
    () => claimSfpRuntimeDeploymentOwner(),
    /SFP_RUNTIME_OWNER_BLOCKED:CURRENT_RELEASE_NOT_SELECTED/,
    "claiming authority directly cannot bypass the release selector",
  );
  process.env.REPL_DEPLOYMENT_ID = redeployedIdentity;
  const recoveredOwner = await assertSfpRuntimeAuthority(cohortRunId);
  assert.equal(recoveredOwner.deploymentIdentity, redeployedIdentity);
  assert.ok(recoveredOwner.ownerEpoch > reclaimedOwner.ownerEpoch,
    "the selector-authorized same-SHA redeployment receives the next owner epoch");
  assert.equal((await getSfpRuntimeReleaseSelectionStatus()).ready, true,
    "the new release is ready only after it claims a live fenced owner lease");

  // Program activity is re-checked at the final dispatch boundary, not only
  // at preview/reservation time. A disabled program never invokes transport.
  const inactiveProgramStage = await createAccountingStage("apollo-disabled-program");
  const inactiveProgramReservation = await reserveSfpProviderOperation({
    stageRunId: inactiveProgramStage,
    cohortRunId,
    businessId: businessA,
    provider: "apollo",
    purpose: "sfp_named_decision_maker_discovery",
    idempotencyKey: `${runKey}-apollo-disabled-program`,
    actorId,
    workUnit: "request",
    units: 1,
  });
  const beforeDisabledDispatch = apolloFixtureCalls;
  await db.execute(sql`UPDATE sfp_programs SET is_active=FALSE WHERE id=${String(program.id)}::uuid`);
  await assert.rejects(
    () => invokeSfpProviderTransport(inactiveProgramReservation, async () => {
      apolloFixtureCalls++;
      throw new Error("TASK_2060_DISABLED_PROGRAM_REACHED_TRANSPORT");
    }),
    /SFP_PROVIDER_DISPATCH_BOUNDARY_LOST|PROGRAM|COHORT|FENCE/i,
  );
  assert.equal(apolloFixtureCalls, beforeDisabledDispatch,
    "a disabled program is blocked by the final dispatch gate before transport");
  await db.execute(sql`UPDATE sfp_programs SET is_active=TRUE WHERE id=${String(program.id)}::uuid`);
  await finishSfpProviderOperation({
    reservation: inactiveProgramReservation,
    outcome: "not_dispatched",
    observation: "transport",
    businessId: businessA,
    workUnit: "request",
    workCompleted: 0,
    providerUsage: {
      status: "not_applicable", quantity: null, unit: null,
      providerRequestId: null, source: "not_dispatched",
    },
    resultData: { retrievalState: "program_disabled_before_dispatch" },
  });

  assert.equal(getBlockedCertificationNetworkAttemptCount(), 0, "no external network request escaped the deny boundary");
  console.log(
    `Task 2060 disposable integrated pipeline certification passed: ` +
    `${zeroBounceCalls} governed ZeroBounce fixtures, ${outScraperCalls} paid result fixtures, ` +
    `3 typed sources, three paused enrollments, exact-decimal/reconciliation and runtime-owner fences verified.`,
  );
} finally {
  if (reviewApiServer) {
    await new Promise<void>((resolve, reject) =>
      reviewApiServer.close((error: Error | undefined) => error ? reject(error) : resolve()),
    );
  }
  if (pool) await pool.end();
}