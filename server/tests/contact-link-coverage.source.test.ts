import assert from "node:assert/strict";
import {
  CONTACT_LINK_COVERAGE_BATCH_SQL as SERVICE_BATCH_SQL,
  addContactLinkCoveragePage,
  classifyContactLinkCoverage,
  classifyContactLinkCoveragePage,
  emptyContactLinkCoverageCounts,
  isContactLinkEvidenceBoundToCandidate,
  isContactLinkEvidenceIndependent,
  normalizeCoverageAddress,
  normalizeCoverageName,
  resumeContactLinkCoverageState,
  type ContactLinkCoverageBusiness,
  type ContactLinkCoverageContact,
  type ContactLinkCoverageState,
} from "../services/contact-link-coverage";
import { CONTACT_LINK_COVERAGE_BATCH_SQL } from "../services/contact-link-coverage-query";

function contact(overrides: Partial<ContactLinkCoverageContact> = {}): ContactLinkCoverageContact {
  return {
    contactId: 10,
    companyName: "Sunrise Dental",
    emailDomain: "sunrisedental.com",
    emailHasExactlyOneAt: true,
    website: "https://www.sunrisedental.com",
    address: "100 Main Street",
    city: "Miami",
    state: "FL",
    phone: "(305) 555-0188",
    rowProvenance: {},
    recordClass: "production",
    emailStatus: "unvalidated",
    archived: false,
    existingMerchantCustomer: false,
    doNotContact: false,
    doNotAutoContact: false,
    optedOutEmail: false,
    optOutStatus: "active",
    unsubscribeStatus: "active",
    bounceStatus: "none",
    complaintStatus: "none",
    suppressionReason: null,
    projectedBusinessId: null,
    currentDecisionId: null,
    currentDecision: null,
    currentDecisionBusinessId: null,
    currentRevision: 0,
    currentDecisionConsistent: false,
    primarySourceEventId: 901,
    rawSunbizCandidates: [],
    sourceEvents: [{
      eventId: 901,
      eventKey: "import:source:row:1",
      sourceCategory: "csv_import",
      sourceType: "csv_contact",
      sourceExternalId: null,
      actorType: "system",
      actorId: "importer",
      metadata: {},
    }],
    businesses: [business()],
    ...overrides,
  };
}

function business(overrides: Partial<ContactLinkCoverageBusiness> = {}): ContactLinkCoverageBusiness {
  return {
    businessId: 20,
    canonicalName: "Sunrise Dental",
    normalizedName: "sunrise dental",
    websiteDomain: "sunrisedental.com",
    mainPhone: "3055550188",
    streetAddress: "100 Main Street",
    city: "Miami",
    state: "FL",
    postalCode: "33101",
    recordClass: "canonical",
    doNotVisit: false,
    domainBusinessCount: 1,
    rawSunbizMatches: [],
    sourceLinks: [{
      sourceLinkId: "source-link-1",
      businessId: 20,
      sourceSystem: "sunbiz",
      sourceType: "sunbiz_entity",
      stableKey: "FILING-1",
      rawEvidence: null,
      sourceEntityId: 101,
      sunbizName: "Sunrise Dental",
      sunbizDba: null,
      sunbizWebsite: "https://sunrisedental.com",
      sunbizFilingNumber: "FILING-1",
      sunbizAddress: "100 Main Street",
      sunbizCity: "Miami",
      sunbizState: "FL",
      sunbizZip: "33101",
      sunbizPhone: "3055550188",
      sunbizOwnerPhone: null,
      sunbizEntitySource: "cordata",
    }],
    ...overrides,
  };
}

function testClassifierVariants() {
  const legalAndDba = classifyContactLinkCoverage(contact({
    companyName: "Sunrise Family Dentistry",
    businesses: [business({
      canonicalName: "Sunrise Dental LLC",
      sourceLinks: [{
        ...business().sourceLinks[0],
        sunbizName: "Sunrise Dental LLC",
        sunbizDba: "Sunrise Family Dentistry",
      }],
    })],
  }));
  assert.equal(legalAndDba.bucket, "RECOVERABLE_IDENTITY", "DBA plus retained phone/site/address corroboration should be recoverable, not strict");
  assert.equal(legalAndDba.candidates[0].signals.find(signal => signal.kind === "name")?.matched, true);

  const gmail = classifyContactLinkCoverage(contact({ emailDomain: "gmail.com" }));
  assert.equal(gmail.bucket, "RECOVERABLE_IDENTITY", "personal email must not reject a proven business relationship");
  assert.ok(gmail.candidates[0].reasons.includes("personal_email_not_identity_rejection"));
  assert.ok(gmail.candidates[0].reasons.includes("email_domain_not_independent_corporate_domain"),
    "Gmail remains a strict-auto ineligibility reason while not rejecting the broader identity candidate");

  const domainOnly = classifyContactLinkCoverage(contact({
    companyName: "Unrelated Company",
    address: null,
    city: null,
    state: null,
    phone: null,
  }));
  assert.equal(domainOnly.bucket, "REVIEW",
    "website and matching corporate email are one domain signal, not two independent identity signals");
  assert.equal(domainOnly.candidates[0].independentSignalCount, 1);

  const missingSunbizSite = classifyContactLinkCoverage(contact({
    companyName: "Sunrise Dental Incorporated",
    businesses: [business({
      sourceLinks: [{
        ...business().sourceLinks[0],
        sunbizWebsite: null,
      }],
    })],
  }));
  assert.equal(missingSunbizSite.bucket, "RECOVERABLE_IDENTITY");
  assert.ok(missingSunbizSite.candidates[0].reasons.includes("sunbiz_website_missing"));
  assert.equal(missingSunbizSite.candidates[0].signals.find(signal => signal.kind === "phone")?.matched, true);

  const ambiguous = classifyContactLinkCoverage(contact({
    emailDomain: "gmail.com",
    businesses: [
      business({ businessId: 20, domainBusinessCount: 2 }),
      business({
        businessId: 21,
        canonicalName: "Sunrise Dental West",
        normalizedName: "sunrise dental west",
        mainPhone: "3055550188",
        domainBusinessCount: 2,
        sourceLinks: [{
          ...business().sourceLinks[0],
          sourceLinkId: "source-link-2",
          businessId: 21,
          sunbizName: "Sunrise Dental West LLC",
          sunbizFilingNumber: "FILING-2",
          stableKey: "FILING-2",
        }],
      }),
    ],
  }));
  assert.equal(ambiguous.bucket, "REVIEW");
  assert.ok(ambiguous.reasons.includes("multiple_business_candidates"));

  const filingConflict = classifyContactLinkCoverage(contact({
    rowProvenance: { filing_number: "FILING-1" },
    businesses: [business({
      sourceLinks: [{
        ...business().sourceLinks[0],
        stableKey: "FILING-OLD",
        sunbizFilingNumber: "FILING-1",
      }],
    })],
  }));
  assert.equal(filingConflict.bucket, "REVIEW", "conflicting source-link and entity filing identifiers require review");
  assert.ok(filingConflict.candidates[0].conflicts.some(conflict => conflict.code === "source_link_filing_number_mismatch"));

  const projectedOnly = classifyContactLinkCoverage(contact({
    projectedBusinessId: 20,
    currentDecisionId: null,
    currentDecision: null,
    businesses: [],
  }));
  assert.equal(projectedOnly.bucket, "REVIEW", "contacts.business_id alone is never authoritative and requires reconciliation");
  assert.ok(projectedOnly.reasons.includes("projection_is_not_link_authority"));

  const authoritative = classifyContactLinkCoverage(contact({
    projectedBusinessId: 20,
    currentDecisionId: "decision-1",
    currentDecision: "verified",
    currentDecisionBusinessId: 20,
    currentRevision: 4,
    currentDecisionConsistent: true,
    businesses: [],
  }));
  assert.equal(authoritative.bucket, "ALREADY_VERIFIED");
}

function testHonestDiscoveryAndRawSourceRecoveryBuckets() {
  const unlinkedRaw = {
    sourceEntityId: 701,
    filingNumber: "RAW-701",
    entityName: "Sunrise Dental LLC",
    dba: "Sunrise Family Dentistry",
    website: "https://sunrisedental.com",
    principalAddress: "100 Main Street",
    principalCity: "Miami",
    principalState: "FL",
    principalZip: "33101",
    phone: "3055550188",
    ownerPhone: null,
    entitySource: "cordata",
  };
  const rawRecovered = classifyContactLinkCoverage(contact({
    companyName: "Sunrise Family Dentistry",
    businesses: [business({ sourceLinks: [], rawSunbizMatches: [unlinkedRaw] })],
    rawSunbizCandidates: [unlinkedRaw],
  }));
  assert.equal(rawRecovered.bucket, "RECOVERABLE_IDENTITY");
  assert.notEqual(rawRecovered.candidates[0].status, "STRICT_AUTO_ELIGIBLE",
    "unlinked raw source evidence cannot bypass the unchanged system-link source requirement");
  assert.ok(rawRecovered.candidates[0].reasons.includes(
    "raw_sunbiz_identity_requires_supported_canonical_source_materialization",
  ));
  assert.equal((rawRecovered.candidates[0].evidence.rawSunbizCandidates as any[])[0].canonicalSourceLinkMaterialized, false);

  const rawNeedsBusiness = classifyContactLinkCoverage(contact({
    businesses: [],
    rawSunbizCandidates: [unlinkedRaw],
  }));
  assert.equal(rawNeedsBusiness.bucket, "NEEDS_BUSINESS_DISCOVERY",
    "retrieved filing without a canonical business is discovery work, not rejection");
  assert.equal(classifyContactLinkCoverage(contact({ businesses: [] })).bucket, "NEEDS_BUSINESS_DISCOVERY",
    "a usable named organization without a canonical match still needs discovery");
  assert.equal(classifyContactLinkCoverage(contact({
    companyName: null, website: null, emailDomain: null, phone: null, address: null, businesses: [],
  })).bucket, "UNUSABLE", "unusable is reserved for records without a usable business identity");
  assert.equal(classifyContactLinkCoverage(contact({ archived: true })).bucket, "OUT_OF_SCOPE");
  assert.equal(classifyContactLinkCoverage(contact({ doNotContact: true })).bucket, "SUPPRESSED");

  const ambiguousRaw = classifyContactLinkCoverage(contact({
    businesses: [business({ sourceLinks: [], rawSunbizMatches: [
      unlinkedRaw,
      { ...unlinkedRaw, sourceEntityId: 702, filingNumber: "RAW-702", entityName: "Sunrise Dental Inc" },
    ] })],
  }));
  assert.equal(ambiguousRaw.bucket, "REVIEW", "multiple raw filings remain ambiguous even with matching names");
}

function testStrictPrerequisiteAndReviewerIndependence() {
  const strict = classifyContactLinkCoverage(contact());
  assert.equal(strict.bucket, "STRICT_AUTO_ELIGIBLE");
  const personalEmail = classifyContactLinkCoverage(contact({ emailDomain: "gmail.com" }));
  assert.notEqual(personalEmail.bucket, "STRICT_AUTO_ELIGIBLE");
  assert.equal(personalEmail.bucket, "RECOVERABLE_IDENTITY");
  assert.equal(isContactLinkEvidenceIndependent({ actorType: "user", actorId: "reviewer-a" }, "reviewer-a"), false);
  assert.equal(isContactLinkEvidenceIndependent({ actorType: "user", actorId: "other-admin" }, "reviewer-a"), true);
  assert.equal(isContactLinkEvidenceIndependent({ actorType: "system", actorId: "contact-link-coverage" }, "reviewer-a"), true);

  const crossSourcePredicateMatch = classifyContactLinkCoverage(contact({
    businesses: [business({
      sourceLinks: [
        {
          ...business().sourceLinks[0],
          sourceLinkId: "source-domain",
          sunbizName: "Unrelated Corporate Name",
          sunbizFilingNumber: "FILING-DOMAIN",
          stableKey: "FILING-DOMAIN",
        },
        {
          ...business().sourceLinks[0],
          sourceLinkId: "source-name",
          sunbizWebsite: "https://different-domain.example",
          sunbizFilingNumber: "FILING-NAME",
          stableKey: "FILING-NAME",
        },
      ],
    })],
  }));
  assert.notEqual(crossSourcePredicateMatch.bucket, "STRICT_AUTO_ELIGIBLE",
    "strict predicates must all hold on the same source-link/entity tuple");

  const malformedEmail = classifyContactLinkCoverage(contact({ emailHasExactlyOneAt: false }));
  assert.notEqual(malformedEmail.bucket, "STRICT_AUTO_ELIGIBLE");

  assert.equal(normalizeCoverageName(" Acme LLC "), "acme",
    "coverage name normalization matches SQL suffix removal, whitespace collapse, and trim");
  assert.equal(normalizeCoverageName("Café & Sons, Ltd."), "caf sons",
    "coverage name normalization matches SQL ASCII key semantics without accent folding or ampersand expansion");
  assert.equal(normalizeCoverageAddress("Café-1 Main St."), "caf1mainst",
    "coverage address keys match SQL's ASCII-only normalization");
  const accentFoldedPolicyMatch = classifyContactLinkCoverage(contact({
    companyName: "Café Dental",
    businesses: [business({
      canonicalName: "Cafe Dental",
      normalizedName: "cafe dental",
      sourceLinks: [{
        ...business().sourceLinks[0],
        sunbizName: "Cafe Dental",
      }],
    })],
  }));
  assert.notEqual(accentFoldedPolicyMatch.bucket, "STRICT_AUTO_ELIGIBLE",
    "accent folding in the shared policy cannot bypass the unchanged database guard's ASCII name comparison");
  assert.ok(accentFoldedPolicyMatch.candidates[0].reasons.includes("database_system_link_guard_identity_mismatch"));

  const databaseHostMismatch = classifyContactLinkCoverage(contact({
    website: "https://www.sunrisedental.com:8443/contact",
  }));
  assert.notEqual(databaseHostMismatch.bucket, "STRICT_AUTO_ELIGIBLE",
    "URL normalization cannot bypass the database guard's exact website host predicate");

  const evidenceContact = contact();
  const evidenceCandidate = classifyContactLinkCoverage(evidenceContact).candidates[0];
  const unboundEvent = evidenceContact.sourceEvents[0];
  assert.equal(isContactLinkEvidenceBoundToCandidate(unboundEvent, evidenceCandidate), false,
    "an event attached to the contact alone is not business-link evidence");
  const boundEvent = { ...unboundEvent, metadata: { businessId: evidenceCandidate.businessId } };
  assert.equal(isContactLinkEvidenceBoundToCandidate(boundEvent, evidenceCandidate), true);
  const unrelatedEvent = { ...unboundEvent, metadata: { businessId: evidenceCandidate.businessId + 1 } };
  assert.equal(isContactLinkEvidenceBoundToCandidate(unrelatedEvent, evidenceCandidate), false);
  const rowProvenanceOnlyEvent = { ...unboundEvent, sourceCategory: "manual", sourceType: "note", sourceExternalId: null, metadata: { businessId: 99 } };
  const provenanceContact = contact({ rowProvenance: { filing_number: "FILING-1" }, sourceEvents: [rowProvenanceOnlyEvent] });
  const provenanceCandidate = classifyContactLinkCoverage(provenanceContact).candidates[0];
  assert.equal(isContactLinkEvidenceBoundToCandidate(rowProvenanceOnlyEvent, provenanceCandidate), false,
    "filing keys from the contact provenance must not be inherited by an unrelated event");
  assert.equal(isContactLinkEvidenceIndependent(
    { actorType: "user", actorId: "reviewer-a" },
    "reviewer-a",
  ), false, "reviewer-created evidence cannot authorize that reviewer's verified decision");
  const staleEventSnapshot = classifyContactLinkCoverage(contact({
    sourceEvents: [{ ...unboundEvent, metadata: { businessId: 999 } }],
  }));
  assert.notEqual(staleEventSnapshot.snapshotHash, classifyContactLinkCoverage(evidenceContact).snapshotHash,
    "candidate snapshots include event content, not only event IDs");
}

function testOverlappingReasonsAndResumableDenominator() {
  const row = contact({ emailDomain: "gmail.com" });
  const pageOne = classifyContactLinkCoveragePage([row]);
  assert.equal(pageOne.counts.RECOVERABLE_IDENTITY, 1);
  assert.equal(pageOne.denominator, 1);
  assert.equal(Object.values(pageOne.counts).reduce((total, count) => total + count, 0), pageOne.denominator,
    "the mutually-exclusive coverage buckets reconcile to the page denominator");
  assert.equal(pageOne.reasonCounts.personal_email_not_identity_rejection, 1,
    "a reason appearing on the contact and candidate counts once for that contact");

  const initial: ContactLinkCoverageState = {
    workflow: "contact_link_coverage_v1",
    runId: "run-1",
    status: "paused",
    watermark: 20,
    cursor: 0,
    total: 2,
    processed: 0,
    counts: emptyContactLinkCoverageCounts(),
    reasonCounts: {},
    complete: false,
    startedAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    lastError: null,
  };
  const resumed = resumeContactLinkCoverageState(initial);
  assert.equal(resumed.status, "running");
  const first = addContactLinkCoveragePage(resumed, pageOne, 10, 1);
  assert.equal(first.processed, 1);
  assert.equal(first.total, 2, "resumption preserves the frozen denominator");
  assert.equal(first.complete, false);

  const pageTwo = classifyContactLinkCoveragePage([contact({ contactId: 20, businesses: [] })]);
  const complete = addContactLinkCoveragePage(first, pageTwo, 20, 1);
  assert.equal(complete.processed, 2);
  assert.equal(complete.cursor, 20);
  assert.equal(complete.complete, true);
  assert.equal(complete.status, "completed");

  const replayedPage = addContactLinkCoveragePage(complete, pageTwo, 20, 1);
  assert.equal(replayedPage, complete, "a duplicate checkpoint page is idempotently ignored");
}

function testBatchedSqlShape() {
  assert.equal(SERVICE_BATCH_SQL, CONTACT_LINK_COVERAGE_BATCH_SQL,
    "the workflow service and replica CLI share the optimized read-only SQL");
  assert.match(CONTACT_LINK_COVERAGE_BATCH_SQL, /business_identity_keys AS (?:NOT )?MATERIALIZED/);
  assert.match(CONTACT_LINK_COVERAGE_BATCH_SQL, /FROM business_identity_keys business_keys/);
  assert.match(CONTACT_LINK_COVERAGE_BATCH_SQL, /business_keys\.key=contact_keys\.key/);
  assert.match(CONTACT_LINK_COVERAGE_BATCH_SQL, /se\.filing_number = csl\.stable_key/);
  assert.match(CONTACT_LINK_COVERAGE_BATCH_SQL, /LEFT JOIN sunbiz_entities se ON se\.filing_number = csl\.stable_key/);
  assert.match(CONTACT_LINK_COVERAGE_BATCH_SQL, /p\.projected_business_id/);
  assert.match(CONTACT_LINK_COVERAGE_BATCH_SQL, /p\.current_decision_business_id/);
  assert.doesNotMatch(CONTACT_LINK_COVERAGE_BATCH_SQL, /lower\s*\(\s*se\.filing_number/i);
  assert.doesNotMatch(CONTACT_LINK_COVERAGE_BATCH_SQL, /OR\s+b\.website_domain/i);
  assert.doesNotMatch(CONTACT_LINK_COVERAGE_BATCH_SQL, /SELECT DISTINCT source FROM sunbiz_entities/);
  // Domain uniqueness uses the database-generated, indexed coverage key.
  assert.match(CONTACT_LINK_COVERAGE_BATCH_SQL, /counted\.coverage_keys\[4\]=b\.coverage_keys\[4\]/);
  assert.doesNotMatch(CONTACT_LINK_COVERAGE_BATCH_SQL, /SELECT count\(\*\)::int FROM businesses same_domain/);
  assert.match(CONTACT_LINK_COVERAGE_BATCH_SQL, /source_links_by_business AS MATERIALIZED/);
  assert.match(CONTACT_LINK_COVERAGE_BATCH_SQL, /GROUP BY source\.business_id/);
  for (const filingField of ["filing_number", "filingNumber", "sunbiz_filing_number", "sunbizFilingNumber"]) {
    assert.match(CONTACT_LINK_COVERAGE_BATCH_SQL, new RegExp(`e\\.metadata->>'${filingField}'`));
  }
  assert.match(CONTACT_LINK_COVERAGE_BATCH_SQL, /concat_ws\(' ', e\.source_category, e\.source_type\) ~\* '\(filing\|sunbiz\)'/);
  assert.doesNotMatch(CONTACT_LINK_COVERAGE_BATCH_SQL, /coalesce\(\s*e\.metadata->>/);
  assert.match(CONTACT_LINK_COVERAGE_BATCH_SQL, /GROUP BY[^;]+c\.email_has_exactly_one_at/s);
  assert.match(CONTACT_LINK_COVERAGE_BATCH_SQL, /LIMIT \$3/);
  assert.match(CONTACT_LINK_COVERAGE_BATCH_SQL, /raw_unlinked_sunbiz_by_contact AS MATERIALIZED/);
  assert.match(CONTACT_LINK_COVERAGE_BATCH_SQL, /rawSunbizMatches/);
  assert.match(CONTACT_LINK_COVERAGE_BATCH_SQL, /csl\.stable_key = se\.filing_number/);
  assert.match(CONTACT_LINK_COVERAGE_BATCH_SQL, /se\.contact_identity_name_key\s*=\s*contact_key\.key/);
  assert.match(CONTACT_LINK_COVERAGE_BATCH_SQL, /se\.contact_identity_dba_key\s*=\s*contact_key\.key/);
  assert.match(CONTACT_LINK_COVERAGE_BATCH_SQL, /LIMIT 21/);
  assert.doesNotMatch(CONTACT_LINK_COVERAGE_BATCH_SQL, /JOIN\s+sunbiz_entities\s+se\s+ON\s+TRUE/i);
}

testClassifierVariants();
testHonestDiscoveryAndRawSourceRecoveryBuckets();
testStrictPrerequisiteAndReviewerIndependence();
testOverlappingReasonsAndResumableDenominator();
testBatchedSqlShape();
console.log("contact-link-coverage source tests passed");
