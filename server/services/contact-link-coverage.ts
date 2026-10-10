import crypto from "node:crypto";
import {normalizeStateIdentity} from "../../shared/state-identity";
import {
  CONTACT_LINK_COVERAGE_BATCH_SQL as OPTIMIZED_CONTACT_LINK_COVERAGE_BATCH_SQL,
  CONTACT_LINK_COVERAGE_WATERMARK_SQL as OPTIMIZED_CONTACT_LINK_COVERAGE_WATERMARK_SQL,
} from "./contact-link-coverage-query";
import {
  evaluateSystemLinkFacts,
  matchesSystemLinkDatabaseGuardIdentity,
  type SystemLinkFacts,
} from "./contact-business-system-link-policy";
import { sanitizeAuditPayload } from "./audit-sanitizer";

export const CONTACT_LINK_COVERAGE_WORKFLOW = "contact_link_coverage_v1";
export const CONTACT_LINK_COVERAGE_CHECKPOINT_ACTION = "contact_business_reconciliation_checkpoint";
export const CONTACT_LINK_COVERAGE_PAGE_SIZE = 500;
// Keep processing explicitly bounded without imposing a new throughput cap.
// Starting the run commits separately from this identity-resolution work.
export const CONTACT_LINK_COVERAGE_PROCESSING_PAGE_SIZE = CONTACT_LINK_COVERAGE_PAGE_SIZE;
export const CONTACT_LINK_COVERAGE_BATCH_SQL = OPTIMIZED_CONTACT_LINK_COVERAGE_BATCH_SQL;
export const CONTACT_LINK_COVERAGE_WATERMARK_SQL = OPTIMIZED_CONTACT_LINK_COVERAGE_WATERMARK_SQL;

const SHARED_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "outlook.com",
  "hotmail.com", "live.com", "aol.com", "icloud.com", "me.com", "msn.com",
  "proton.me", "protonmail.com", "mail.com", "comcast.net", "att.net",
]);
const LEGAL_SUFFIXES = /\b(incorporated|inc|limited|ltd|llc|llp|corp|corporation|company|co)\b/g;
const CANDIDATE_SOURCE_VERSION = CONTACT_LINK_COVERAGE_WORKFLOW;

export type ContactLinkCoverageBucket =
  | "STRICT_AUTO_ELIGIBLE"
  | "ALREADY_VERIFIED"
  | "RECOVERABLE_IDENTITY"
  | "NEEDS_BUSINESS_DISCOVERY"
  | "REVIEW"
  | "OUT_OF_SCOPE"
  | "SUPPRESSED"
  | "UNUSABLE";

export interface ContactLinkCoverageCounts {
  STRICT_AUTO_ELIGIBLE: number;
  ALREADY_VERIFIED: number;
  RECOVERABLE_IDENTITY: number;
  NEEDS_BUSINESS_DISCOVERY: number;
  REVIEW: number;
  OUT_OF_SCOPE: number;
  SUPPRESSED: number;
  UNUSABLE: number;
}

export interface ContactLinkCoverageState {
  workflow: string;
  runId: string;
  status: "running" | "ready" | "paused" | "completed" | "error";
  watermark: number;
  cursor: number;
  total: number;
  processed: number;
  counts: ContactLinkCoverageCounts;
  reasonCounts: Record<string, number>;
  complete: boolean;
  startedAt: string;
  updatedAt: string;
  lastError: string | null;
  serverProcessing?: boolean;
}

export interface ContactLinkCoverageSourceLink {
  sourceLinkId: string;
  businessId: number;
  sourceSystem: string;
  sourceType: string;
  stableKey: string | null;
  rawEvidence: unknown;
  sourceEntityId: number | null;
  sunbizName: string | null;
  sunbizDba: string | null;
  sunbizWebsite: string | null;
  sunbizFilingNumber: string | null;
  sunbizAddress: string | null;
  sunbizCity: string | null;
  sunbizState: string | null;
  sunbizZip: string | null;
  sunbizPhone: string | null;
  sunbizOwnerPhone: string | null;
  sunbizEntitySource: string | null;
}

export interface ContactLinkCoverageSourceEvent {
  eventId: number;
  eventKey?: string;
  sourceCategory: string;
  sourceType: string;
  sourceExternalId?: string | null;
  actorType: string;
  actorId: string | null;
  metadata?: unknown;
}

export interface ContactLinkCoverageRawSunbizMatch {
  sourceEntityId: number;
  filingNumber: string;
  entityName: string;
  dba: string | null;
  website: string | null;
  principalAddress: string | null;
  principalCity: string | null;
  principalState: string | null;
  principalZip: string | null;
  phone: string | null;
  ownerPhone: string | null;
  entitySource: string | null;
}

export interface ContactLinkCoverageBusiness {
  automaticRelationshipReasons?: string[];
  businessId: number;
  canonicalName: string;
  normalizedName: string;
  websiteDomain: string | null;
  mainPhone: string | null;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  recordClass: string | null;
  doNotVisit: boolean;
  domainBusinessCount: number;
  sourceLinks: ContactLinkCoverageSourceLink[];
  rawSunbizMatches: ContactLinkCoverageRawSunbizMatch[];
}

export interface ContactLinkCoverageContact {
  contactId: number;
  companyName: string | null;
  emailDomain: string | null;
  emailHasExactlyOneAt: boolean;
  website: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  phone: string | null;
  rowProvenance: unknown;
  recordClass: string | null;
  emailStatus: string | null;
  archived: boolean;
  existingMerchantCustomer: boolean;
  doNotContact: boolean;
  doNotAutoContact: boolean;
  optedOutEmail: boolean;
  optOutStatus: string | null;
  unsubscribeStatus: string | null;
  bounceStatus: string | null;
  complaintStatus: string | null;
  suppressionReason: string | null;
  projectedBusinessId: number | null;
  currentDecisionId: string | null;
  currentDecision: string | null;
  currentDecisionBusinessId: number | null;
  currentRevision: number;
  currentDecisionConsistent: boolean;
  primarySourceEventId: number | null;
  sourceEvents: ContactLinkCoverageSourceEvent[];
  rawSunbizCandidates: ContactLinkCoverageRawSunbizMatch[];
  businesses: ContactLinkCoverageBusiness[];
}

export interface ContactLinkCoverageSignal {
  kind: "name" | "filing_identifier" | "address" | "phone" | "website" | "corporate_email_domain";
  matched: boolean;
  detail: string;
}

export interface ContactLinkCoverageCandidate {
  businessId: number;
  status: ContactLinkCoverageBucket;
  reasons: string[];
  signals: ContactLinkCoverageSignal[];
  independentSignalCount: number;
  evidenceSourceEventIds: number[];
  evidence: Record<string, unknown>;
  conflicts: Array<Record<string, unknown>>;
  expectedRevision: number;
  snapshotHash: string;
}

export interface ContactLinkCoverageClassification {
  contactId: number;
  bucket: ContactLinkCoverageBucket;
  reasons: string[];
  candidates: ContactLinkCoverageCandidate[];
  expectedRevision: number;
  snapshotHash: string;
}

export interface ContactLinkCoveragePageResult {
  rows: ContactLinkCoverageContact[];
  denominator: number;
  nextCursor: number | null;
  processed: number;
  counts: ContactLinkCoverageCounts;
  reasonCounts: Record<string, number>;
  classifications: ContactLinkCoverageClassification[];
}

export interface ReadonlyQueryFunction {
  (sqlText: string, params: unknown[]): Promise<{ rows?: unknown[] } | unknown[]>;
}

/** One datasource call returns an entire 500-contact page; never N+1 by contact. */
export async function loadContactLinkCoverageBatch(
  query: ReadonlyQueryFunction,
  input: { afterContactId: number; watermark: number; contactIds?: number[] },
): Promise<ContactLinkCoverageContact[]> {
  const result = await query(CONTACT_LINK_COVERAGE_BATCH_SQL, [
    input.afterContactId,
    input.watermark,
    CONTACT_LINK_COVERAGE_PAGE_SIZE,
    input.contactIds?.length ? input.contactIds : null,
  ]);
  const rows = Array.isArray(result) ? result : result.rows ?? [];
  return mapContactLinkCoverageRows(rows);
}

/** Pure row mapper exported for the replica census CLI. */
export function mapContactLinkCoverageRows(rows: unknown[]): ContactLinkCoverageContact[] {
  return rows.map(normalizeCoverageContactRow);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value === "string") {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return (value ?? fallback) as T;
}

function normalizeCoverageContactRow(row: any): ContactLinkCoverageContact {
  const events = parseJson<any[]>(row.sourceEvents ?? row.source_events, []);
  const businesses = parseJson<any[]>(row.businesses, []);
  const rawSunbizCandidates = parseJson<any[]>(row.rawSunbizCandidates ?? row.raw_sunbiz_candidates, []);
  const mapRawSunbizMatch = (source: any): ContactLinkCoverageRawSunbizMatch => ({
    sourceEntityId: Number(source.sourceEntityId ?? source.source_entity_id),
    filingNumber: String(source.filingNumber ?? source.filing_number ?? ""),
    entityName: String(source.entityName ?? source.entity_name ?? ""),
    dba: source.dba ?? null,
    website: source.website ?? null,
    principalAddress: source.principalAddress ?? source.principal_address ?? null,
    principalCity: source.principalCity ?? source.principal_city ?? null,
    principalState: source.principalState ?? source.principal_state ?? null,
    principalZip: source.principalZip ?? source.principal_zip ?? null,
    phone: source.phone ?? null,
    ownerPhone: source.ownerPhone ?? source.owner_phone ?? null,
    entitySource: source.entitySource ?? source.entity_source ?? null,
  });
  return {
    contactId: Number(row.contactId ?? row.contact_id),
    companyName: row.companyName ?? row.company_name ?? null,
    emailDomain: row.emailDomain ?? row.email_domain ?? null,
    emailHasExactlyOneAt: Boolean(row.emailHasExactlyOneAt ?? row.email_has_exactly_one_at),
    website: row.website ?? null,
    address: row.address ?? null,
    city: row.city ?? null,
    state: row.state ?? null,
    phone: row.phone ?? null,
    rowProvenance: row.rowProvenance ?? row.row_provenance ?? null,
    recordClass: row.recordClass ?? row.record_class ?? null,
    emailStatus: row.emailStatus ?? row.email_status ?? null,
    archived: Boolean(row.archived ?? row.archived_at),
    existingMerchantCustomer: Boolean(row.existingMerchantCustomer ?? row.existing_merchant_customer),
    doNotContact: Boolean(row.doNotContact ?? row.do_not_contact),
    doNotAutoContact: Boolean(row.doNotAutoContact ?? row.do_not_auto_contact),
    optedOutEmail: Boolean(row.optedOutEmail ?? row.opted_out_email),
    optOutStatus: row.optOutStatus ?? row.opt_out_status ?? null,
    unsubscribeStatus: row.unsubscribeStatus ?? row.unsubscribe_status ?? null,
    bounceStatus: row.bounceStatus ?? row.bounce_status ?? null,
    complaintStatus: row.complaintStatus ?? row.complaint_status ?? null,
    suppressionReason: row.suppressionReason ?? row.suppression_reason ?? null,
    projectedBusinessId: numberOrNull(row.projectedBusinessId ?? row.projected_business_id),
    currentDecisionId: row.currentDecisionId ?? row.current_decision_id ?? null,
    currentDecision: row.currentDecision ?? row.current_decision ?? null,
    currentDecisionBusinessId: numberOrNull(row.currentDecisionBusinessId ?? row.current_decision_business_id),
    currentRevision: Number(row.currentRevision ?? row.current_revision ?? 0),
    currentDecisionConsistent: Boolean(row.currentDecisionConsistent ?? row.current_decision_consistent),
    primarySourceEventId: numberOrNull(row.primarySourceEventId ?? row.primary_source_event_id),
    sourceEvents: events.map((event: any) => ({
      eventId: Number(event.eventId ?? event.event_id ?? event.id),
      eventKey: event.eventKey ?? event.event_key,
      sourceCategory: String(event.sourceCategory ?? event.source_category ?? ""),
      sourceType: String(event.sourceType ?? event.source_type ?? ""),
      sourceExternalId: event.sourceExternalId ?? event.source_external_id ?? null,
      actorType: String(event.actorType ?? event.actor_type ?? ""),
      actorId: event.actorId ?? event.actor_id ?? null,
      metadata: event.metadata ?? null,
    })),
    rawSunbizCandidates: rawSunbizCandidates.map(mapRawSunbizMatch),
    businesses: businesses.map((business: any) => ({
      businessId: Number(business.businessId ?? business.business_id),
      canonicalName: String(business.canonicalName ?? business.canonical_name ?? ""),
      normalizedName: String(business.normalizedName ?? business.normalized_name ?? ""),
      websiteDomain: business.websiteDomain ?? business.website_domain ?? null,
      mainPhone: business.mainPhone ?? business.main_phone ?? null,
      streetAddress: business.streetAddress ?? business.street_address ?? null,
      city: business.city ?? null,
      state: business.state ?? null,
      postalCode: business.postalCode ?? business.postal_code ?? null,
      recordClass: business.recordClass ?? business.record_class ?? null,
      doNotVisit: Boolean(business.doNotVisit ?? business.do_not_visit),
      domainBusinessCount: Number(business.domainBusinessCount ?? business.domain_business_count ?? 0),
      automaticRelationshipReasons: Array.isArray(business.automaticRelationshipReasons)
        ? business.automaticRelationshipReasons.map(String) : undefined,
      rawSunbizMatches: parseJson<any[]>(business.rawSunbizMatches ?? business.raw_sunbiz_matches, [])
        .map(mapRawSunbizMatch),
      sourceLinks: parseJson<any[]>(business.sourceLinks ?? business.source_links, []).map((source: any) => ({
        sourceLinkId: String(source.sourceLinkId ?? source.source_link_id),
        businessId: Number(source.businessId ?? source.business_id),
        sourceSystem: String(source.sourceSystem ?? source.source_system ?? ""),
        sourceType: String(source.sourceType ?? source.source_type ?? ""),
        stableKey: source.stableKey ?? source.stable_key ?? null,
        rawEvidence: source.rawEvidence ?? source.raw_evidence ?? null,
        sourceEntityId: numberOrNull(source.sourceEntityId ?? source.source_entity_id),
        sunbizName: source.sunbizName ?? source.sunbiz_name ?? null,
        sunbizDba: source.sunbizDba ?? source.sunbiz_dba ?? null,
        sunbizWebsite: source.sunbizWebsite ?? source.sunbiz_website ?? null,
        sunbizFilingNumber: source.sunbizFilingNumber ?? source.sunbiz_filing_number ?? null,
        sunbizAddress: source.sunbizAddress ?? source.sunbiz_address ?? null,
        sunbizCity: source.sunbizCity ?? source.sunbiz_city ?? null,
        sunbizState: source.sunbizState ?? source.sunbiz_state ?? null,
        sunbizZip: source.sunbizZip ?? source.sunbiz_zip ?? null,
        sunbizPhone: source.sunbizPhone ?? source.sunbiz_phone ?? null,
        sunbizOwnerPhone: source.sunbizOwnerPhone ?? source.sunbiz_owner_phone ?? null,
        sunbizEntitySource: source.sunbizEntitySource ?? source.sunbiz_entity_source ?? null,
      })),
    })),
  };
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeCoverageName(value: unknown): string {
  return String(value ?? "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase()
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCoverageAddress(value: unknown): string {
  return String(value ?? "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function normalizeDomain(value: unknown): string | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  try {
    const host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname
      .replace(/^www\./, "").replace(/\.$/, "");
    return host && !host.includes(" ") ? host : null;
  } catch {
    return null;
  }
}

function normalizePhone(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

function normalizeAddress(value: unknown): string {
  return normalizeCoverageAddress(value);
}

function nameCorroborates(left: unknown, right: unknown): boolean {
  const a = normalizeCoverageName(left);
  const b = normalizeCoverageName(right);
  if (a.length < 4 || b.length < 4) return false;
  if (a === b) return true;
  const at = new Set(a.split(" ").filter(token => token.length > 1));
  const bt = new Set(b.split(" ").filter(token => token.length > 1));
  if (at.size < 2 || bt.size < 2) return false;
  const shared = [...at].filter(token => bt.has(token)).length;
  return shared / Math.min(at.size, bt.size) >= 0.8;
}

function readFilingKeys(contact: ContactLinkCoverageContact): Set<string> {
  const keys = new Set<string>();
  const add = (value: unknown) => {
    const key = String(value ?? "");
    if (key) keys.add(key.toLowerCase());
  };
  const provenance = typeof contact.rowProvenance === "string"
    ? parseJson<any>(contact.rowProvenance, {})
    : contact.rowProvenance as any;
  if (provenance && typeof provenance === "object") {
    for (const key of ["filing_number", "filingNumber", "sunbiz_filing_number", "sunbizFilingNumber"]) {
      add(provenance[key]);
    }
  }
  for (const event of contact.sourceEvents) {
    const metadata = typeof event.metadata === "string" ? parseJson<any>(event.metadata, {}) : event.metadata as any;
    if (metadata && typeof metadata === "object") {
      for (const key of ["filing_number", "filingNumber", "sunbiz_filing_number", "sunbizFilingNumber"]) {
        add(metadata[key]);
      }
    }
    if (event.sourceExternalId && /filing|sunbiz/i.test(`${event.sourceCategory} ${event.sourceType}`)) {
      add(event.sourceExternalId);
    }
  }
  return keys;
}

function stableHash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function strictReasons(contact: ContactLinkCoverageContact, business: ContactLinkCoverageBusiness): string[] {
  if (business.automaticRelationshipReasons) return [...business.automaticRelationshipReasons];
  const sourceTuples: Array<ContactLinkCoverageSourceLink | null> = business.sourceLinks.length
    ? business.sourceLinks
    : [null];
  const evaluations = sourceTuples.map(source => {
    const facts: SystemLinkFacts = {
      contactId: contact.contactId,
      businessId: business.businessId,
      sourceLinkId: source?.sourceLinkId ?? null,
      sourceEntityId: source?.sourceEntityId ?? null,
      companyName: contact.companyName,
      contactWebsite: contact.website,
      contactEmail: contact.emailHasExactlyOneAt && contact.emailDomain
        ? `coverage@${contact.emailDomain}`
        : "malformed-contact-email",
      contactRecordClass: contact.recordClass,
      emailStatus: contact.emailStatus,
      archivedAt: contact.archived ? true : null,
      existingMerchantCustomer: contact.existingMerchantCustomer,
      doNotContact: contact.doNotContact,
      doNotAutoContact: contact.doNotAutoContact,
      optedOutEmail: contact.optedOutEmail,
      optOutStatus: contact.optOutStatus,
      unsubscribeStatus: contact.unsubscribeStatus,
      bounceStatus: contact.bounceStatus,
      complaintStatus: contact.complaintStatus,
      suppressionReason: contact.suppressionReason,
      businessRecordClass: business.recordClass,
      doNotVisit: business.doNotVisit,
      canonicalName: business.canonicalName,
      businessDomain: business.websiteDomain,
      sunbizName: source?.sunbizName ?? null,
      sunbizWebsite: source?.sunbizWebsite ?? null,
      sourceSystem: source?.sourceSystem ?? null,
      sourceType: source?.sourceType ?? null,
      sourceStableKey: source?.stableKey ?? null,
      sunbizEntitySource: source?.sunbizEntitySource ?? null,
      filingNumber: source?.sunbizFilingNumber ?? null,
      domainBusinessCount: business.domainBusinessCount,
      currentDecisionId: contact.currentDecisionId,
      currentDecision: contact.currentDecision,
      projectedBusinessId: contact.projectedBusinessId,
    };
    const reasons = evaluateSystemLinkFacts(facts);
    if (!matchesSystemLinkDatabaseGuardIdentity(facts)) {
      reasons.push("database_system_link_guard_identity_mismatch");
    }
    return { source, reasons };
  });
  const eligible = evaluations.filter(evaluation => evaluation.reasons.length === 0);
  if (eligible.length === 1) return [];
  const reasons = new Set(evaluations.flatMap(evaluation => evaluation.reasons));
  if (eligible.length > 1) reasons.add("independent_sunbiz_source_ambiguous");
  return [...reasons];
}

function pairSignals(contact: ContactLinkCoverageContact, business: ContactLinkCoverageBusiness) {
  const links = business.sourceLinks;
  const names = [
    business.canonicalName,
    ...links.flatMap(link => [link.sunbizName, link.sunbizDba]).filter(Boolean) as string[],
    ...business.rawSunbizMatches.flatMap(source => [source.entityName, source.dba]).filter(Boolean) as string[],
  ];
  const rawMatches = business.rawSunbizMatches ?? [];
  const filingKeys = readFilingKeys(contact);
  const linkedFilings = links.flatMap(link => [
    link.stableKey,
    link.sunbizFilingNumber,
  ]).filter((value): value is string => Boolean(value)).map(value => value.toLowerCase())
    .concat(rawMatches.map(source => source.filingNumber.toLowerCase()).filter(Boolean));
  const filingMatch = [...filingKeys].some(key => linkedFilings.includes(key));
  const contactPhone = normalizePhone(contact.phone);
  const phoneValues = [
    business.mainPhone,
    ...links.flatMap(link => [link.sunbizPhone, link.sunbizOwnerPhone]),
    ...rawMatches.flatMap(source => [source.phone, source.ownerPhone]),
  ]
    .map(normalizePhone).filter(Boolean);
  const phoneMatch = Boolean(contactPhone && phoneValues.includes(contactPhone));
  const contactAddress = normalizeAddress(contact.address);
  const addressMatch = Boolean(contactAddress && (
    contactAddress === normalizeAddress(business.streetAddress)
    && (!contact.city || !business.city || normalizeCoverageName(contact.city) === normalizeCoverageName(business.city))
    && (!contact.state || !business.state || normalizeStateIdentity(contact.state) === normalizeStateIdentity(business.state))
    || links.some(link =>
      contactAddress === normalizeAddress(link.sunbizAddress)
      && (!contact.city || !link.sunbizCity || normalizeCoverageName(contact.city) === normalizeCoverageName(link.sunbizCity))
      && (!contact.state || !link.sunbizState || normalizeStateIdentity(contact.state) === normalizeStateIdentity(link.sunbizState)),
    )
    || rawMatches.some(source =>
      contactAddress === normalizeAddress(source.principalAddress)
      && (!contact.city || !source.principalCity || normalizeCoverageName(contact.city) === normalizeCoverageName(source.principalCity))
      && (!contact.state || !source.principalState || normalizeStateIdentity(contact.state) === normalizeStateIdentity(source.principalState)),
    )
  ));
  const contactDomain = normalizeDomain(contact.website);
  const businessDomain = normalizeDomain(business.websiteDomain);
  const websiteMatch = Boolean(contactDomain && (
    contactDomain === businessDomain
    || links.some(link => normalizeDomain(link.sunbizWebsite) === contactDomain)
    || rawMatches.some(source => normalizeDomain(source.website) === contactDomain)
  ));
  const emailDomain = contact.emailHasExactlyOneAt ? String(contact.emailDomain ?? "").trim().toLowerCase() : "";
  const corporateEmailMatch = Boolean(emailDomain && !SHARED_EMAIL_DOMAINS.has(emailDomain)
    && (emailDomain === businessDomain
      || links.some(link => normalizeDomain(link.sunbizWebsite) === emailDomain)
      || rawMatches.some(source => normalizeDomain(source.website) === emailDomain)));
  const matchingNames = names.filter(name => nameCorroborates(contact.companyName, name));
  const nameMatch = matchingNames.length > 0;
  const signals: ContactLinkCoverageSignal[] = [
    { kind: "name", matched: nameMatch, detail: nameMatch ? "contact company name aligns with canonical, retained, or indexed raw Sunbiz legal name/DBA" : "no canonical or retrieved legal-name/DBA alignment" },
    { kind: "filing_identifier", matched: filingMatch, detail: filingMatch ? "contact retained filing identifier matches a linked or indexed raw Sunbiz filing" : "no retained contact filing identifier match" },
    { kind: "address", matched: addressMatch, detail: addressMatch ? "normalized contact address and locality match canonical or retained/raw Sunbiz principal address" : "no address and locality match" },
    { kind: "phone", matched: phoneMatch, detail: phoneMatch ? "normalized contact phone matches canonical or retained/raw Sunbiz phone" : "no phone match" },
    { kind: "website", matched: websiteMatch, detail: websiteMatch ? "contact website domain matches canonical or retained/raw Sunbiz website" : "no contact website domain match" },
    { kind: "corporate_email_domain", matched: corporateEmailMatch, detail: corporateEmailMatch ? "non-shared email domain aligns with official business domain" : "email domain is not an independent corporate-domain match" },
  ];
  const independentSignalCount = signals.filter(signal =>
    signal.matched && signal.kind !== "corporate_email_domain",
  ).length + Number(corporateEmailMatch && !websiteMatch);
  return {
    signals,
    independentSignalCount,
    matchingNames,
    filingMatch,
    phoneMatch,
    addressMatch,
    websiteMatch,
    corporateEmailMatch,
  };
}

function sourceEventIds(contact: ContactLinkCoverageContact): number[] {
  return [...new Set(contact.sourceEvents.map(event => event.eventId).filter(Number.isSafeInteger))].sort((a, b) => a - b);
}

function identityConflicts(
  contact: ContactLinkCoverageContact,
  business: ContactLinkCoverageBusiness,
  candidateBusinessIds: number[],
): Array<Record<string, unknown>> {
  const conflicts: Array<Record<string, unknown>> = [];
  const rawSunbizMatches = business.rawSunbizMatches ?? [];
  if (candidateBusinessIds.length > 1) {
    conflicts.push({ code: "multiple_business_candidates", candidateBusinessIds });
  }
  if (rawSunbizMatches.length > 1) {
    conflicts.push({
      code: "multiple_unlinked_sunbiz_identity_candidates",
      sourceEntityIds: rawSunbizMatches.map(source => source.sourceEntityId),
      filingNumbers: [...new Set(rawSunbizMatches.map(source => source.filingNumber))],
    });
  }
  for (const link of business.sourceLinks) {
    if (link.stableKey && link.sunbizFilingNumber
        && link.stableKey.toLowerCase() !== link.sunbizFilingNumber.toLowerCase()) {
      conflicts.push({
        code: "source_link_filing_number_mismatch",
        sourceLinkId: link.sourceLinkId,
        sourceStableKey: link.stableKey,
        entityFilingNumber: link.sunbizFilingNumber,
      });
    }
  }
  const filings = new Set(business.sourceLinks.map(link => link.sunbizFilingNumber).filter(Boolean));
  if (filings.size > 1) conflicts.push({ code: "multiple_sunbiz_filings_for_business", filingNumbers: [...filings] });
  const officialNames = new Set(business.sourceLinks.flatMap(link => [link.sunbizName, link.sunbizDba]).filter(Boolean)
    .map(name => normalizeCoverageName(name)));
  if (officialNames.size > 1 && ![...officialNames].some(name => nameCorroborates(contact.companyName, name))) {
    conflicts.push({ code: "filing_name_conflict", retainedNameCount: officialNames.size });
  }
  const filedAddresses = new Set(business.sourceLinks.map(link =>
    normalizeAddress(`${link.sunbizAddress ?? ""}${link.sunbizCity ?? ""}${link.sunbizState ?? ""}`),
  ).filter(Boolean));
  if (filedAddresses.size > 1) conflicts.push({ code: "filing_address_conflict", retainedAddressCount: filedAddresses.size });
  if (contact.currentDecisionId && contact.currentDecisionBusinessId !== business.businessId) {
    conflicts.push({ code: "current_decision_targets_other_business", currentBusinessId: contact.currentDecisionBusinessId });
  }
  if (contact.currentDecisionId && !(contact.currentDecision === "verified" && contact.currentDecisionConsistent)) {
    conflicts.push({
      code: "current_link_decision_requires_explicit_review",
      currentDecision: contact.currentDecision,
      currentBusinessId: contact.currentDecisionBusinessId,
    });
  }
  if (contact.projectedBusinessId !== null && (
    contact.currentDecision !== "verified"
    || contact.currentDecisionBusinessId !== contact.projectedBusinessId
  )) {
    conflicts.push({ code: "untrusted_or_inconsistent_business_projection", projectedBusinessId: contact.projectedBusinessId });
  }
  return conflicts;
}

function evidenceSummary(contact: ContactLinkCoverageContact, business: ContactLinkCoverageBusiness, signals: ContactLinkCoverageSignal[]) {
  return {
    contactCompanyName: contact.companyName,
    contactWebsiteDomain: normalizeDomain(contact.website),
    contactPhoneLast4: normalizePhone(contact.phone).slice(-4) || null,
    contactAddressMatched: signals.some(signal => signal.kind === "address" && signal.matched),
    business: {
      id: business.businessId,
      canonicalName: business.canonicalName,
      websiteDomain: business.websiteDomain,
      recordClass: business.recordClass,
    },
    sourceLinks: business.sourceLinks.map(source => ({
      sourceLinkId: source.sourceLinkId,
      sourceSystem: source.sourceSystem,
      sourceType: source.sourceType,
      stableKey: source.stableKey,
      rawEvidence: source.rawEvidence,
      sourceEntityId: source.sourceEntityId,
      sunbizName: source.sunbizName,
      sunbizDba: source.sunbizDba,
      sunbizFilingNumber: source.sunbizFilingNumber,
      sunbizWebsiteDomain: normalizeDomain(source.sunbizWebsite),
      sunbizAddress: source.sunbizAddress,
      sunbizCity: source.sunbizCity,
      sunbizState: source.sunbizState,
      sunbizEntitySource: source.sunbizEntitySource,
    })),
    rawSunbizCandidates: (business.rawSunbizMatches ?? []).map(source => ({
      sourceEntityId: source.sourceEntityId,
      filingNumber: source.filingNumber,
      entityName: source.entityName,
      dba: source.dba,
      websiteDomain: normalizeDomain(source.website),
      principalAddress: source.principalAddress,
      principalCity: source.principalCity,
      principalState: source.principalState,
      entitySource: source.entitySource,
      canonicalSourceLinkMaterialized: false,
    })),
    sourceEvents: contact.sourceEvents.map(event => ({
      eventId: event.eventId,
      sourceCategory: event.sourceCategory,
      sourceType: event.sourceType,
    })),
    matchedSignals: signals.filter(signal => signal.matched),
  };
}

function candidateSnapshot(contact: ContactLinkCoverageContact, business: ContactLinkCoverageBusiness, facts: {
  reasons: string[];
  signals: ContactLinkCoverageSignal[];
  conflicts: Array<Record<string, unknown>>;
  status: ContactLinkCoverageBucket;
}) {
  return stableHash({
    classifierVersion: CONTACT_LINK_COVERAGE_WORKFLOW,
    contactId: contact.contactId,
    businessId: business.businessId,
    companyName: normalizeCoverageName(contact.companyName),
    contactWebsite: normalizeDomain(contact.website),
    contactPhone: normalizePhone(contact.phone),
    contactAddress: normalizeAddress(contact.address),
    contactCity: normalizeCoverageName(contact.city),
    contactState: normalizeCoverageName(contact.state),
    contactEmailDomain: String(contact.emailDomain ?? "").toLowerCase(),
    rowProvenance: contact.rowProvenance,
    recordClass: contact.recordClass,
    emailStatus: contact.emailStatus,
    archived: contact.archived,
    existingMerchantCustomer: contact.existingMerchantCustomer,
    doNotContact: contact.doNotContact,
    doNotAutoContact: contact.doNotAutoContact,
    optedOutEmail: contact.optedOutEmail,
    optOutStatus: contact.optOutStatus,
    unsubscribeStatus: contact.unsubscribeStatus,
    bounceStatus: contact.bounceStatus,
    complaintStatus: contact.complaintStatus,
    suppressionReason: contact.suppressionReason,
    projectedBusinessId: contact.projectedBusinessId,
    currentDecisionId: contact.currentDecisionId,
    currentDecision: contact.currentDecision,
    currentDecisionBusinessId: contact.currentDecisionBusinessId,
    currentRevision: contact.currentRevision,
    sourceEvents: contact.sourceEvents.map(event => ({
      eventId: event.eventId,
      eventKey: event.eventKey ?? null,
      sourceCategory: event.sourceCategory,
      sourceType: event.sourceType,
      sourceExternalId: event.sourceExternalId ?? null,
      actorType: event.actorType,
      actorId: event.actorId,
      metadataHash: stableHash(event.metadata ?? null),
    })),
    businessName: business.canonicalName,
    businessDomain: business.websiteDomain,
    businessPhone: normalizePhone(business.mainPhone),
    businessAddress: normalizeAddress(business.streetAddress),
    businessLocation: [business.city, business.state, business.postalCode].map(normalizeCoverageName),
    businessRecordClass: business.recordClass,
    domainBusinessCount: business.domainBusinessCount,
    sourceLinks: business.sourceLinks.map(link => ({
      sourceLinkId: link.sourceLinkId,
      stableKey: link.stableKey,
      rawEvidenceHash: stableHash(link.rawEvidence ?? null),
      sourceSystem: link.sourceSystem,
      sourceType: link.sourceType,
      sourceEntityId: link.sourceEntityId,
      name: normalizeCoverageName(link.sunbizName),
      dba: normalizeCoverageName(link.sunbizDba),
      website: normalizeDomain(link.sunbizWebsite),
      filingNumber: link.sunbizFilingNumber,
      address: normalizeAddress(link.sunbizAddress),
      city: normalizeCoverageName(link.sunbizCity),
      state: normalizeCoverageName(link.sunbizState),
      phone: normalizePhone(link.sunbizPhone),
      entitySource: link.sunbizEntitySource,
    })),
    rawSunbizCandidates: (business.rawSunbizMatches ?? []).map(source => ({
      sourceEntityId: source.sourceEntityId,
      filingNumber: source.filingNumber,
      name: normalizeCoverageName(source.entityName),
      dba: normalizeCoverageName(source.dba),
      website: normalizeDomain(source.website),
      address: normalizeAddress(source.principalAddress),
      city: normalizeCoverageName(source.principalCity),
      state: normalizeCoverageName(source.principalState),
      phone: normalizePhone(source.phone),
      entitySource: source.entitySource,
      canonicalSourceLinkMaterialized: false,
    })),
    reasons: facts.reasons,
    signals: facts.signals,
    conflicts: facts.conflicts,
    status: facts.status,
  });
}

function classifyBusinessCandidate(
  contact: ContactLinkCoverageContact,
  business: ContactLinkCoverageBusiness,
  candidateBusinessIds: number[],
): ContactLinkCoverageCandidate {
  const facts = pairSignals(contact, business);
  const conflicts = identityConflicts(contact, business, candidateBusinessIds);
  const systemReasons = strictReasons(contact, business);
  const strictEligible = systemReasons.length === 0;
  const reasons = new Set<string>();
  for (const reason of systemReasons) reasons.add(reason);
  for (const conflict of conflicts) reasons.add(String(conflict.code));
  if (!business.sourceLinks.length) reasons.add("independent_sunbiz_source_link_missing");
  if (!business.sourceLinks.some(link => link.sunbizWebsite)) reasons.add("sunbiz_website_missing");
  if (SHARED_EMAIL_DOMAINS.has(String(contact.emailDomain ?? "").toLowerCase())) {
    // Personal email addresses do not reject a proven organization relationship.
    reasons.add("personal_email_not_identity_rejection");
  }
  if (contact.currentDecision === "verified" && !contact.currentDecisionConsistent) {
    reasons.add("verified_decision_projection_conflict");
  }
  if (contact.projectedBusinessId !== null && contact.currentDecision !== "verified") {
    reasons.add("projection_is_not_link_authority");
  }
  const hasRetainedSunbizLink = business.sourceLinks.some(link =>
    link.sourceSystem === "sunbiz" && link.sourceType === "sunbiz_entity",
  );
  const hasResolvedSunbizEntity = business.sourceLinks.some(link =>
    link.sourceSystem === "sunbiz" && link.sourceType === "sunbiz_entity" && link.sourceEntityId !== null,
  );
  const nonProduction = contact.archived || ["test", "demo", "synthetic"].includes(String(contact.recordClass))
    || ["test", "demo", "synthetic"].includes(String(business.recordClass));
  const nonCanonicalBusiness = business.recordClass !== "canonical";
  const suppressed = contact.doNotContact || contact.doNotAutoContact || contact.optedOutEmail
    || contact.optOutStatus === "opted_out" || contact.unsubscribeStatus === "unsubscribed"
    || contact.bounceStatus === "hard" || contact.complaintStatus === "reported"
    || contact.suppressionReason !== null;
  const hasRawSunbizSource = (business.rawSunbizMatches ?? []).length > 0;
  let status: ContactLinkCoverageBucket;
  if (strictEligible) {
    status = "STRICT_AUTO_ELIGIBLE";
  } else if (nonProduction) {
    status = "OUT_OF_SCOPE";
    if (nonProduction) reasons.add("non_production_or_archived_record");
  } else if (suppressed) {
    status = "SUPPRESSED";
    reasons.add("contact_suppressed_or_excluded");
  } else if (nonCanonicalBusiness) {
    status = "REVIEW";
    reasons.add("business_not_canonical");
  } else if (conflicts.length > 0) {
    status = "REVIEW";
  } else if (hasRetainedSunbizLink && !hasResolvedSunbizEntity) {
    status = "REVIEW";
    reasons.add("sunbiz_source_link_entity_unresolved_or_untrusted");
  } else if (facts.independentSignalCount >= 2) {
    if (hasRetainedSunbizLink || hasRawSunbizSource) {
      status = "RECOVERABLE_IDENTITY";
      if (hasRawSunbizSource && !hasRetainedSunbizLink) {
        reasons.add("raw_sunbiz_identity_requires_supported_canonical_source_materialization");
      }
    } else {
      status = "REVIEW";
      reasons.add("independent_corroboration_without_canonical_source_evidence");
    }
  } else {
    status = "REVIEW";
    reasons.add(facts.independentSignalCount === 0
      ? "independent_identity_corroboration_missing"
      : "only_one_independent_identity_signal");
    if (!hasRetainedSunbizLink && !hasRawSunbizSource) reasons.add("canonical_sunbiz_source_not_found");
  }
  const candidateReasons = [...reasons].sort();
  const snapshotHash = candidateSnapshot(contact, business, {
    reasons: candidateReasons,
    signals: facts.signals,
    conflicts,
    status,
  });
  return {
    businessId: business.businessId,
    status,
    reasons: candidateReasons,
    signals: facts.signals,
    independentSignalCount: facts.independentSignalCount,
    evidenceSourceEventIds: sourceEventIds(contact),
    evidence: evidenceSummary(contact, business, facts.signals),
    conflicts,
    expectedRevision: contact.currentRevision,
    snapshotHash,
  };
}

export function classifyContactLinkCoverage(
  contact: ContactLinkCoverageContact,
): ContactLinkCoverageClassification {
  const candidateBusinessIds = contact.businesses.map(business => business.businessId);
  const candidates = contact.businesses.map(business =>
    classifyBusinessCandidate(contact, business, candidateBusinessIds),
  );
  const nonProductionContact = contact.archived
    || ["test", "demo", "synthetic"].includes(String(contact.recordClass));
  const suppressed = contact.doNotContact || contact.doNotAutoContact || contact.optedOutEmail
    || contact.optOutStatus === "opted_out" || contact.unsubscribeStatus === "unsubscribed"
    || contact.bounceStatus === "hard" || contact.complaintStatus === "reported"
    || contact.suppressionReason !== null;
  if (nonProductionContact) {
    const reasons = contact.archived ? ["archived_contact"] : ["non_production_contact"];
    return {
      contactId: contact.contactId,
      bucket: "OUT_OF_SCOPE",
      reasons,
      candidates,
      expectedRevision: contact.currentRevision,
      snapshotHash: stableHash({ contactId: contact.contactId, recordClass: contact.recordClass, archived: contact.archived, reasons }),
    };
  }
  if (suppressed) {
    const reasons = ["contact_suppressed_or_excluded"];
    return {
      contactId: contact.contactId,
      bucket: "SUPPRESSED",
      reasons,
      candidates,
      expectedRevision: contact.currentRevision,
      snapshotHash: stableHash({
        contactId: contact.contactId,
        doNotContact: contact.doNotContact,
        doNotAutoContact: contact.doNotAutoContact,
        optedOutEmail: contact.optedOutEmail,
        optOutStatus: contact.optOutStatus,
        unsubscribeStatus: contact.unsubscribeStatus,
        bounceStatus: contact.bounceStatus,
        complaintStatus: contact.complaintStatus,
        suppressionReason: contact.suppressionReason,
      }),
    };
  }
  if (contact.currentDecision === "verified" && contact.currentDecisionConsistent
      && contact.currentDecisionBusinessId !== null) {
    const authoritative = candidates.find(candidate => candidate.businessId === contact.currentDecisionBusinessId);
    return {
      contactId: contact.contactId,
      bucket: "ALREADY_VERIFIED",
      reasons: authoritative?.reasons ?? [],
      candidates,
      expectedRevision: contact.currentRevision,
      snapshotHash: stableHash({
        workflow: CONTACT_LINK_COVERAGE_WORKFLOW,
        contactId: contact.contactId,
        decisionId: contact.currentDecisionId,
        decision: contact.currentDecision,
        decisionBusinessId: contact.currentDecisionBusinessId,
        projectedBusinessId: contact.projectedBusinessId,
        revision: contact.currentRevision,
      }),
    };
  }
  if (contact.businesses.length === 0) {
    const hasUsefulIdentity = normalizeCoverageName(contact.companyName).length >= 4
      || Boolean(normalizeDomain(contact.website))
      || Boolean(contact.emailHasExactlyOneAt && contact.emailDomain && !SHARED_EMAIL_DOMAINS.has(contact.emailDomain.toLowerCase()))
      || normalizePhone(contact.phone).length >= 7
      || normalizeAddress(contact.address).length >= 8
      || readFilingKeys(contact).size > 0;
    const reasons = (contact.rawSunbizCandidates ?? []).length
      ? ["unlinked_sunbiz_identity_found", "canonical_business_not_found"]
      : ["canonical_business_candidate_not_found"];
    if (contact.projectedBusinessId !== null) reasons.push("projection_is_not_link_authority");
    if (contact.currentDecisionId) reasons.push("current_link_decision_requires_explicit_review");
    const bucket: ContactLinkCoverageBucket = contact.currentDecisionId || contact.projectedBusinessId !== null
      ? "REVIEW"
      : hasUsefulIdentity ? "NEEDS_BUSINESS_DISCOVERY" : "UNUSABLE";
    if (bucket === "UNUSABLE") reasons.push("no_usable_business_identity");
    return {
      contactId: contact.contactId,
      bucket,
      reasons,
      candidates,
      expectedRevision: contact.currentRevision,
      snapshotHash: stableHash({
        workflow: CONTACT_LINK_COVERAGE_WORKFLOW,
        contactId: contact.contactId,
        companyName: normalizeCoverageName(contact.companyName),
        website: normalizeDomain(contact.website),
        emailDomain: contact.emailHasExactlyOneAt ? contact.emailDomain?.toLowerCase() ?? null : null,
        phone: normalizePhone(contact.phone),
        address: normalizeAddress(contact.address),
        city: normalizeCoverageName(contact.city),
        state: normalizeCoverageName(contact.state),
        filingKeys: [...readFilingKeys(contact)].sort(),
        sourceEventIds: sourceEventIds(contact),
        projectedBusinessId: contact.projectedBusinessId,
        currentDecisionId: contact.currentDecisionId,
        revision: contact.currentRevision,
        rawSunbizCandidates: (contact.rawSunbizCandidates ?? []).map(source => ({
          sourceEntityId: source.sourceEntityId,
          filingNumber: source.filingNumber,
          name: normalizeCoverageName(source.entityName),
          dba: normalizeCoverageName(source.dba),
        })),
        reasons,
      }),
    };
  }
  const strictCandidates = candidates.filter(candidate => candidate.status === "STRICT_AUTO_ELIGIBLE");
  if (strictCandidates.length === 1) {
    return {
      contactId: contact.contactId,
      bucket: "STRICT_AUTO_ELIGIBLE",
      reasons: strictCandidates[0].reasons,
      candidates,
      expectedRevision: contact.currentRevision,
      snapshotHash: strictCandidates[0].snapshotHash,
    };
  }
  if (candidates.length === 1) {
    return {
      contactId: contact.contactId,
      bucket: candidates[0].status,
      reasons: candidates[0].reasons,
      candidates,
      expectedRevision: contact.currentRevision,
      snapshotHash: candidates[0].snapshotHash,
    };
  }
  const reasons = [...new Set(candidates.flatMap(candidate => candidate.reasons).concat("multiple_business_candidates"))].sort();
  return {
    contactId: contact.contactId,
    bucket: "REVIEW",
    reasons,
    candidates,
    expectedRevision: contact.currentRevision,
    snapshotHash: stableHash({
      workflow: CONTACT_LINK_COVERAGE_WORKFLOW,
      contactId: contact.contactId,
      candidateSnapshots: candidates.map(candidate => candidate.snapshotHash).sort(),
      reasons,
    }),
  };
}

export function classifyContactLinkCoveragePage(
  rows: ContactLinkCoverageContact[],
): Omit<ContactLinkCoveragePageResult, "nextCursor" | "processed"> {
  const counts: ContactLinkCoverageCounts = {
    STRICT_AUTO_ELIGIBLE: 0,
    ALREADY_VERIFIED: 0,
    RECOVERABLE_IDENTITY: 0,
    NEEDS_BUSINESS_DISCOVERY: 0,
    REVIEW: 0,
    OUT_OF_SCOPE: 0,
    SUPPRESSED: 0,
    UNUSABLE: 0,
  };
  const reasonCounts: Record<string, number> = {};
  const classifications = rows.map(row => classifyContactLinkCoverage(row));
  for (const classification of classifications) {
    counts[classification.bucket] += 1;
    const contactReasons = new Set(classification.reasons);
    for (const candidate of classification.candidates) {
      for (const reason of candidate.reasons) contactReasons.add(reason);
    }
    for (const reason of contactReasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  }
  return { rows, denominator: rows.length, counts, reasonCounts, classifications };
}

export function emptyContactLinkCoverageCounts(): ContactLinkCoverageCounts {
  return {
    STRICT_AUTO_ELIGIBLE: 0,
    ALREADY_VERIFIED: 0,
    RECOVERABLE_IDENTITY: 0,
    NEEDS_BUSINESS_DISCOVERY: 0,
    REVIEW: 0,
    OUT_OF_SCOPE: 0,
    SUPPRESSED: 0,
    UNUSABLE: 0,
  };
}

export function emptyContactLinkCoverageState(): Omit<ContactLinkCoverageState, "runId" | "startedAt" | "updatedAt"> & {
  runId: null;
  startedAt: null;
  updatedAt: null;
} {
  return {
    workflow: CONTACT_LINK_COVERAGE_WORKFLOW,
    runId: null,
    status: "completed",
    watermark: 0,
    cursor: 0,
    total: 0,
    processed: 0,
    counts: emptyContactLinkCoverageCounts(),
    reasonCounts: {},
    complete: false,
    startedAt: null,
    updatedAt: null,
    lastError: null,
  };
}

export function addContactLinkCoveragePage(
  state: ContactLinkCoverageState,
  page: Omit<ContactLinkCoveragePageResult, "nextCursor" | "processed">,
  lastContactId: number | null,
  pageLength: number,
): ContactLinkCoverageState {
  if (lastContactId === null || lastContactId <= state.cursor || state.complete) return state;
  const next: ContactLinkCoverageState = {
    ...state,
    counts: { ...state.counts },
    reasonCounts: { ...state.reasonCounts },
    processed: state.processed + pageLength,
    cursor: lastContactId ?? state.cursor,
    updatedAt: new Date().toISOString(),
    lastError: null,
  };
  for (const bucket of Object.keys(next.counts) as ContactLinkCoverageBucket[]) {
    next.counts[bucket] += page.counts[bucket];
  }
  for (const [reason, count] of Object.entries(page.reasonCounts)) {
    next.reasonCounts[reason] = (next.reasonCounts[reason] ?? 0) + count;
  }
  if (next.cursor >= next.watermark && next.processed === next.total) {
    next.status = "completed";
    next.complete = true;
  } else {
    next.status = "ready";
    next.complete = false;
  }
  return next;
}

export function resumeContactLinkCoverageState(state: ContactLinkCoverageState): ContactLinkCoverageState {
  if (state.complete || state.status === "completed") throw new Error("CONTACT_LINK_COVERAGE_ALREADY_COMPLETED");
  if (state.status === "error") throw new Error(state.lastError ?? "CONTACT_LINK_COVERAGE_DENOMINATOR_DRIFT");
  return { ...state, status: "running", updatedAt: new Date().toISOString(), lastError: null };
}

export function isContactLinkEvidenceIndependent(
  evidence: Pick<ContactLinkCoverageSourceEvent, "actorType" | "actorId">,
  reviewerId: string,
): boolean {
  return !(evidence.actorType === "user" && evidence.actorId === reviewerId);
}

export function isContactLinkEvidenceBoundToCandidate(
  event: ContactLinkCoverageSourceEvent,
  candidate: ContactLinkCoverageCandidate,
): boolean {
  if (event.eventKey?.startsWith("contact-link-coverage-observation:")) return false;
  const metadata = typeof event.metadata === "string" ? parseJson<any>(event.metadata, {}) : event.metadata as any;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const linkedSources = (candidate.evidence.sourceLinks as any[] | undefined) ?? [];
  const sourceLinkIds = new Set(linkedSources.map(source => String(source.sourceLinkId)));
  const sourceEntityIds = new Set(linkedSources
    .filter(source => source.sourceEntityId != null && source.sourceEntityId !== "")
    .map(source => Number(source.sourceEntityId))
    .filter(Number.isSafeInteger));
  const filingNumbers = new Set(linkedSources.flatMap(source =>
    [source.stableKey, source.sunbizFilingNumber].filter(Boolean).map((value: string) => value.toLowerCase()),
  ));
  const directBusinessIds = [
    metadata.businessId, metadata.business_id, metadata.canonicalBusinessId,
    metadata.canonical_business_id, metadata.candidateBusinessId, metadata.candidate_business_id,
  ].map(numberOrNull).filter((value): value is number => value !== null);
  if (directBusinessIds.some(id => id !== candidate.businessId)) return false;
  const referencedLinkIds = [
    metadata.sourceLinkId, metadata.source_link_id,
    ...(Array.isArray(metadata.sourceLinkIds) ? metadata.sourceLinkIds : []),
    ...(Array.isArray(metadata.source_link_ids) ? metadata.source_link_ids : []),
  ].filter(value => value != null).map(String);
  if (referencedLinkIds.some(id => !sourceLinkIds.has(id))) return false;
  const referencedEntityIds = [
    metadata.sourceEntityId, metadata.source_entity_id,
    ...(Array.isArray(metadata.sourceEntityIds) ? metadata.sourceEntityIds : []),
    ...(Array.isArray(metadata.source_entity_ids) ? metadata.source_entity_ids : []),
  ].map(numberOrNull).filter((value): value is number => value !== null);
  if (referencedEntityIds.some(id => !sourceEntityIds.has(id))) return false;
  const eventFilingKeys = new Set<string>();
  if (metadata && typeof metadata === "object") {
    for (const key of ["filing_number", "filingNumber", "sunbiz_filing_number", "sunbizFilingNumber"]) {
      const value = metadata[key];
      if (typeof value === "string" && value.trim()) eventFilingKeys.add(value.trim().toLowerCase());
    }
  }
  if (event.sourceExternalId && /filing|sunbiz/i.test(`${event.sourceCategory} ${event.sourceType}`)) {
    eventFilingKeys.add(event.sourceExternalId.toLowerCase());
  }
  if ([...eventFilingKeys].some(key => !filingNumbers.has(key))) return false;
  return directBusinessIds.length > 0 || referencedLinkIds.length > 0
    || referencedEntityIds.length > 0 || eventFilingKeys.size > 0;
}

function asCoverageState(value: unknown): ContactLinkCoverageState | null {
  const state = value as Partial<ContactLinkCoverageState> | null;
  if (!state || typeof state !== "object" || state.workflow !== CONTACT_LINK_COVERAGE_WORKFLOW
      || typeof state.runId !== "string"
      || !["running", "ready", "paused", "completed", "error"].includes(String(state.status))) return null;
  const counts = state.counts as Partial<ContactLinkCoverageCounts> | undefined;
  if (!counts || !Number.isSafeInteger(state.watermark) || !Number.isSafeInteger(state.total)
      || !Number.isSafeInteger(state.cursor) || !Number.isSafeInteger(state.processed)) return null;
  if (["RECOVERABLE_RECONCILIATION", "REQUIRES_REVIEW", "REJECTED"]
    .some(bucket => bucket in counts)) return null;
  const normalizedCounts = emptyContactLinkCoverageCounts();
  for (const bucket of Object.keys(normalizedCounts) as ContactLinkCoverageBucket[]) {
    const count = Number(counts[bucket]);
    if (Number.isSafeInteger(count) && count >= 0) normalizedCounts[bucket] = count;
  }
  return {
    ...state,
    counts: normalizedCounts,
  } as ContactLinkCoverageState;
}

function auditDetails(row: any): any {
  return parseJson(row?.details, row?.details ?? null);
}

async function withCoverageTransaction<T>(
  operation: (client: any) => Promise<T>,
): Promise<T> {
  const { pool } = await import("../db");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired",
      [CONTACT_LINK_COVERAGE_WORKFLOW],
    );
    if (!lock.rows[0]?.acquired) throw new Error("CONTACT_LINK_COVERAGE_ALREADY_RUNNING");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function loadCoverageState(client: any, forUpdate = false): Promise<ContactLinkCoverageState | null> {
  const result = await client.query(
    `SELECT details FROM audit_logs
      WHERE action = $1 AND entity_type = 'contact_business_reconciliation'
      ORDER BY id DESC LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [CONTACT_LINK_COVERAGE_CHECKPOINT_ACTION],
  );
  const details = auditDetails(result.rows[0]);
  return asCoverageState(details);
}

async function writeCoverageCheckpoint(client: any, state: ContactLinkCoverageState, actorId: string | null): Promise<void> {
  // Counts/reasons/cursors only: never persist raw contact facts or PII in audit metadata.
  await client.query(
    `INSERT INTO audit_logs
      (user_id,action,entity_type,entity_key,details,actor_type,actor_id,created_at)
     VALUES ($1,$2,'contact_business_reconciliation',$3,$4::jsonb,$5,$6,now())`,
    [
      actorId,
      CONTACT_LINK_COVERAGE_CHECKPOINT_ACTION,
      CONTACT_LINK_COVERAGE_WORKFLOW,
      JSON.stringify(sanitizeAuditPayload(state)),
      actorId ? "user" : "system",
      actorId,
    ],
  );
}

async function insertPageCandidates(client: any, classifications: ContactLinkCoverageClassification[]): Promise<void> {
  const candidateRows: Array<{
    contact_id: number;
    business_id: number;
    candidate_key: string;
    confidence: number;
  }> = [];
  for (const classification of classifications) {
    if (["ALREADY_VERIFIED", "NEEDS_BUSINESS_DISCOVERY", "OUT_OF_SCOPE", "SUPPRESSED", "UNUSABLE"]
      .includes(classification.bucket)) continue;
    for (const candidate of classification.candidates) {
      if (["OUT_OF_SCOPE", "SUPPRESSED", "UNUSABLE"].includes(candidate.status)) continue;
      const candidateKey = crypto.createHash("sha256")
        .update(`${CONTACT_LINK_COVERAGE_WORKFLOW}:${classification.contactId}:${candidate.businessId}`)
        .digest("hex");
      const confidence = Math.max(0, Math.min(99, Math.round(45 + candidate.independentSignalCount * 10)));
      candidateRows.push({
        contact_id: classification.contactId,
        business_id: candidate.businessId,
        candidate_key: candidateKey,
        confidence,
      });
    }
  }
  if (!candidateRows.length) return;
  await client.query(
    `INSERT INTO contact_business_link_candidates
       (contact_id,business_id,source,source_version,candidate_key,confidence)
     SELECT candidate.contact_id,candidate.business_id,'sdr_orchestration',$2,
            candidate.candidate_key,candidate.confidence
       FROM jsonb_to_recordset($1::jsonb) AS candidate(
         contact_id integer,business_id integer,candidate_key text,confidence integer
       )
     ON CONFLICT (candidate_key) DO NOTHING`,
    [JSON.stringify(candidateRows), CANDIDATE_SOURCE_VERSION],
  );
}

export async function processContactLinkCoveragePage(
  client: any,
  state: ContactLinkCoverageState,
  actorId: string | null,
): Promise<ContactLinkCoverageState> {
  state.status = "running";
  await writeCoverageCheckpoint(client, state, actorId);
  const result = await client.query(CONTACT_LINK_COVERAGE_BATCH_SQL, [
    state.cursor,
    state.watermark,
    CONTACT_LINK_COVERAGE_PROCESSING_PAGE_SIZE,
    null,
  ]);
  const page = (result.rows ?? []).map(normalizeCoverageContactRow);
  if (page.length === 0) {
    if (state.processed !== state.total) {
      state.status = "error";
      state.complete = false;
      state.lastError = `CONTACT_LINK_COVERAGE_DENOMINATOR_DRIFT:${state.processed}/${state.total}`;
    } else {
      state.status = "completed";
      state.complete = true;
      state.lastError = null;
    }
    state.updatedAt = new Date().toISOString();
    await writeCoverageCheckpoint(client, state, actorId);
    return state;
  }
  const classified = classifyContactLinkCoveragePage(page);
  const lastContactId = page[page.length - 1].contactId;
  await insertPageCandidates(client, classified.classifications);
  const next = addContactLinkCoveragePage(state, classified, lastContactId, page.length);
  if (next.cursor >= next.watermark && next.processed !== next.total) {
    next.status = "error";
    next.complete = false;
    next.lastError = `CONTACT_LINK_COVERAGE_DENOMINATOR_DRIFT:${next.processed}/${next.total}`;
  }
  await writeCoverageCheckpoint(client, next, actorId);
  return next;
}

export async function initializeContactLinkCoverageRun(
  client: any,
  actorId: string,
): Promise<ContactLinkCoverageState> {
  const current = await loadCoverageState(client, true);
  if (current && current.status !== "completed") throw new Error("CONTACT_LINK_COVERAGE_RESUME_REQUIRED");
  const scope = await client.query(CONTACT_LINK_COVERAGE_WATERMARK_SQL);
  const watermark = Number(scope.rows[0]?.watermark ?? 0);
  const total = Number(scope.rows[0]?.total ?? 0);
  const now = new Date().toISOString();
  const state: ContactLinkCoverageState = {
    workflow: CONTACT_LINK_COVERAGE_WORKFLOW,
    runId: crypto.randomUUID(),
    status: "ready",
    watermark,
    cursor: 0,
    total,
    processed: 0,
    counts: emptyContactLinkCoverageCounts(),
    reasonCounts: {},
    complete: false,
    startedAt: now,
    updatedAt: now,
    lastError: null,
    serverProcessing: true,
  };
  if (total === 0) {
    state.status = "completed";
    state.complete = true;
  }
  // Commit the frozen denominator before any expensive identity query. A
  // failed page can then retry from this durable cursor instead of erasing
  // the entire run along with its first-page transaction.
  await writeCoverageCheckpoint(client, state, actorId);
  return state;
}

export async function startContactLinkCoverage(actorId: string) {
  return withCoverageTransaction(client => initializeContactLinkCoverageRun(client, actorId));
}

export async function stepContactLinkCoverage(actorId: string) {
  return withCoverageTransaction(async client => {
    const state = await loadCoverageState(client, true);
    if (!state) throw new Error("CONTACT_LINK_COVERAGE_NOT_FOUND");
    if (state.status === "paused") throw new Error("CONTACT_LINK_COVERAGE_PAUSED");
    if (state.status === "completed") throw new Error("CONTACT_LINK_COVERAGE_ALREADY_COMPLETED");
    if (state.status === "error") throw new Error("CONTACT_LINK_COVERAGE_RESUME_REQUIRED");
    return processContactLinkCoveragePage(client, state, actorId);
  });
}

export async function pauseContactLinkCoverage(actorId: string) {
  return withCoverageTransaction(async client => {
    const state = await loadCoverageState(client, true);
    if (!state) throw new Error("CONTACT_LINK_COVERAGE_NOT_FOUND");
    if (state.status !== "completed") state.status = "paused";
    state.serverProcessing = false;
    state.updatedAt = new Date().toISOString();
    await writeCoverageCheckpoint(client, state, actorId);
    return state;
  });
}

export async function resumeContactLinkCoverage(actorId: string) {
  return withCoverageTransaction(async client => {
    const state = await loadCoverageState(client, true);
    if (!state) throw new Error("CONTACT_LINK_COVERAGE_NOT_FOUND");
    if (state.status === "completed") throw new Error("CONTACT_LINK_COVERAGE_ALREADY_COMPLETED");
    if (state.status === "error") throw new Error(state.lastError ?? "CONTACT_LINK_COVERAGE_DENOMINATOR_DRIFT");
    state.serverProcessing = true;
    return processContactLinkCoveragePage(client, state, actorId);
  });
}

function serializeCoverageStatus(state: ContactLinkCoverageState | null) {
  if (!state) {
    return {
      runId: null,
      status: "idle",
      watermark: 0,
      cursor: 0,
      total: 0,
      processed: 0,
      counts: emptyContactLinkCoverageCounts(),
      reasonCounts: {},
      complete: false,
    };
  }
  const { runId, status, watermark, cursor, total, processed, counts, reasonCounts, complete, serverProcessing, updatedAt, lastError } = state;
  return { runId, status, watermark, cursor, total, processed, counts, reasonCounts, complete,
    serverProcessing: serverProcessing === true, updatedAt, lastError };
}

/** One bounded, transaction-serialized page; never requires a mounted browser. */
export async function processContactLinkCoverageServerTick() {
  return withCoverageTransaction(async client => {
    const state = await loadCoverageState(client, true);
    if (!state?.serverProcessing || state.complete || !["ready", "running"].includes(state.status)) {
      return { ran: false, reason: state?.status ?? "not_started" };
    }
    const next = await processContactLinkCoveragePage(client, state, null);
    return { ran: true, runId: next.runId, processed: next.processed, status: next.status };
  });
}

export async function getContactLinkCoverageStatus() {
  const { pool } = await import("../db");
  const result = await pool.query(
    `SELECT details FROM audit_logs
      WHERE action = $1 AND entity_type = 'contact_business_reconciliation'
      ORDER BY id DESC LIMIT 1`,
    [CONTACT_LINK_COVERAGE_CHECKPOINT_ACTION],
  );
  return serializeCoverageStatus(asCoverageState(auditDetails(result.rows[0])));
}

export interface ContactLinkCoverageCandidateCursor {
  reviewerId?: string;
  afterCreatedAt?: string;
  afterId?: string;
  limit?: number;
}

const CONTACT_LINK_CANDIDATES_SQL = `
SELECT candidate.id AS "candidateId",candidate.contact_id AS "contactId",
       candidate.business_id AS "businessId",
       to_char(candidate.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
       candidate.candidate_key AS "candidateKey"
  FROM current_contact_business_link_candidates candidate
 WHERE candidate.source_version = $1
   AND (candidate.created_at,candidate.id) > ($2::timestamptz,$3::uuid)
 ORDER BY candidate.created_at,candidate.id
 LIMIT $4
`;

export async function listContactLinkCoverageCandidates(input: ContactLinkCoverageCandidateCursor = {}) {
  const limit = Math.max(1, Math.min(CONTACT_LINK_COVERAGE_PAGE_SIZE, Math.trunc(input.limit ?? 100)));
  const afterCreatedAt = input.afterCreatedAt ?? "1970-01-01T00:00:00.000Z";
  const afterId = input.afterId ?? "00000000-0000-0000-0000-000000000000";
  const { pool } = await import("../db");
  const listed = await pool.query(CONTACT_LINK_CANDIDATES_SQL, [
    CANDIDATE_SOURCE_VERSION,
    afterCreatedAt,
    afterId,
    limit,
  ]);
  const candidates = listed.rows ?? [];
  const contactIds = [...new Set(candidates.map((candidate: any) => Number(candidate.contactId)))];
  let classifiedByContact = new Map<number, ContactLinkCoverageClassification>();
  let contactById = new Map<number, ContactLinkCoverageContact>();
  if (contactIds.length) {
    const rows = await loadContactLinkCoverageBatch(
      (sqlText, params) => pool.query(sqlText, params),
      { afterContactId: 0, watermark: 2147483647, contactIds },
    );
    contactById = new Map(rows.map(row => [row.contactId, row]));
    classifiedByContact = new Map(rows.map(row => [row.contactId, classifyContactLinkCoverage(row)]));
  }
  return {
    candidates: candidates.map((candidate: any) => {
      const contactId = Number(candidate.contactId);
      const businessId = Number(candidate.businessId);
      const contact = contactById.get(contactId);
      const classification = classifiedByContact.get(contactId);
      const detail = classification?.candidates.find(item => item.businessId === businessId);
      const evidenceSourceEventIds = detail && contact ? contact.sourceEvents
        .filter(event => isContactLinkEvidenceIndependent(event, input.reviewerId ?? "")
          && isContactLinkEvidenceBoundToCandidate(event, detail))
        .map(event => event.eventId).sort((a, b) => a - b) : [];
      return {
        candidateId: String(candidate.candidateId),
        contactId,
        businessId,
        evidenceSourceEventIds,
        reviewable: evidenceSourceEventIds.length > 0,
        evidenceHoldReason: evidenceSourceEventIds.length ? null : "CONTACT_LINK_RETAINED_EVIDENCE_UNAVAILABLE",
        evidence: detail?.evidence ?? {},
        conflicts: detail?.conflicts ?? [],
        reasons: detail?.reasons ?? ["candidate_facts_no_longer_match"],
        expectedRevision: detail?.expectedRevision ?? contact?.currentRevision ?? 0,
        snapshotHash: detail?.snapshotHash ?? stableHash({ contactId, businessId, missingCandidateFacts: true }),
      };
    }),
    nextCursor: candidates.length ? {
      createdAt: String((candidates[candidates.length - 1] as any).createdAt),
      id: String((candidates[candidates.length - 1] as any).candidateId),
    } : null,
    limit,
  };
}

function candidateFact(contactId: number, businessId: number, rows: ContactLinkCoverageContact[]) {
  const contact = rows.find(row => row.contactId === contactId);
  if (!contact) return null;
  const classification = classifyContactLinkCoverage(contact);
  if (classification.bucket === "ALREADY_VERIFIED") return null;
  const candidate = classification.candidates.find(item => item.businessId === businessId);
  if (!candidate || ["OUT_OF_SCOPE", "SUPPRESSED", "UNUSABLE"].includes(candidate.status)) return null;
  return { contact, classification, candidate };
}

async function fetchSingleContactCoverage(executor: any, contactId: number): Promise<ContactLinkCoverageContact | null> {
  const rows = await loadContactLinkCoverageBatch(
    (sqlText, params) => queryDrizzleExecutor(executor, sqlText, params),
    { afterContactId: 0, watermark: 2147483647, contactIds: [contactId] },
  );
  return rows[0] ?? null;
}

async function queryDrizzleExecutor(executor: any, queryText: string, values: unknown[]) {
  const { sql } = await import("drizzle-orm");
  const query = sql.empty();
  let lastIndex = 0;
  const parameterPattern = /\$(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = parameterPattern.exec(queryText))) {
    query.append(sql.raw(queryText.slice(lastIndex, match.index)));
    query.append(sql`${sql.param(values[Number(match[1]) - 1])}`);
    lastIndex = match.index + match[0].length;
  }
  query.append(sql.raw(queryText.slice(lastIndex)));
  const result = await executor.execute(query);
  return { rows: (result as any).rows ?? result ?? [] };
}

function reviewDecisionKey(input: {
  contactId: number;
  businessId: number | null;
  decision: string;
  reviewerId: string;
  expectedRevision: number;
  snapshotHash: string;
  evidenceSourceEventId: number | null;
}) {
  return `contact-link-review:${stableHash(input)}`;
}

async function findReviewReplay(executor: any, decisionKey: string, expected: {
  contactId: number;
  businessId: number | null;
  decision: string;
  reviewerId: string;
  evidenceSourceEventId: number | null;
  expectedRevision?: number;
}) {
  const result = await queryDrizzleExecutor(executor, `
    SELECT id,contact_id,business_id,decision,reviewed_by,evidence_source_event_id,revision
      FROM contact_business_link_decisions
     WHERE decision_key = $1
     LIMIT 1
  `, [decisionKey]);
  const row = result.rows[0] as any;
  if (!row) return null;
  const matches = Number(row.contact_id) === expected.contactId
    && numberOrNull(row.business_id) === expected.businessId
    && String(row.decision) === expected.decision
    && String(row.reviewed_by) === expected.reviewerId
    && numberOrNull(row.evidence_source_event_id) === expected.evidenceSourceEventId
    && (expected.expectedRevision === undefined || Number(row.revision) === expected.expectedRevision + 1);
  if (!matches) throw new Error("COMMERCIAL_LINK_DIVERGENT_REPLAY");
  return {
    decisionId: String(row.id),
    revision: Number(row.revision),
    status: "replayed" as const,
  };
}

async function verifyCurrentCandidate(executor: any, input: {
  candidateId: string;
  contactId: number;
  businessId: number;
}) {
  const result = await queryDrizzleExecutor(executor, `
    SELECT candidate.id
      FROM current_contact_business_link_candidates candidate
     WHERE candidate.id = $1::uuid
       AND candidate.contact_id = $2
       AND candidate.business_id = $3
       AND candidate.source_version = $4
     LIMIT 1
  `, [input.candidateId, input.contactId, input.businessId, CANDIDATE_SOURCE_VERSION]);
  return result.rows.length > 0;
}

export interface ContactLinkReviewBatchItem {
  candidateId: string;
  contactId: number;
  businessId: number;
  decision: "verified" | "missing" | "conflicted" | "legacy_unknown" | "rejected";
  expectedRevision: number;
  snapshotHash: string;
  evidenceSourceEventId?: number;
}

export async function reviewContactLinkCoverageBatch(
  items: ContactLinkReviewBatchItem[],
  reviewerId: string,
) {
  const { db } = await import("../db");
  const { decideContactBusinessLink } = await import("./commercial-link-authority");
  const outcomes: Array<Record<string, unknown>> = [];
  for (const item of items) {
    let eventId = item.evidenceSourceEventId ?? null;
    try {
      // Resolve actual retained evidence, never ask an operator to invent an ID
      // and never create derivative "independent" evidence to bypass the guard.
      if (item.decision === "verified" && eventId === null) {
        const retained = await queryDrizzleExecutor(db, `
          SELECT decision_key,evidence_source_event_id FROM contact_business_link_decisions
           WHERE contact_id=$1 AND business_id=$2 AND reviewed_by=$3 AND decision='verified'
             AND revision=$4 AND evidence_source_event_id IS NOT NULL
           ORDER BY id LIMIT 10
        `, [item.contactId, item.businessId, reviewerId, item.expectedRevision + 1]);
        for (const receipt of retained.rows as any[]) {
          const receiptEventId = Number(receipt.evidence_source_event_id);
          const receiptKey = reviewDecisionKey({
            contactId: item.contactId, businessId: item.businessId, decision: item.decision,
            reviewerId, expectedRevision: item.expectedRevision, snapshotHash: item.snapshotHash,
            evidenceSourceEventId: receiptEventId,
          });
          if (receiptKey === receipt.decision_key) { eventId = receiptEventId; break; }
        }
      }
      if (item.decision === "verified" && eventId === null) {
        const contact = await fetchSingleContactCoverage(db, item.contactId);
        const fact = contact ? candidateFact(item.contactId, item.businessId, [contact]) : null;
        if (!fact || fact.candidate.snapshotHash !== item.snapshotHash ||
            fact.candidate.expectedRevision !== item.expectedRevision) {
          throw new Error("CONTACT_LINK_CANDIDATE_NOT_CURRENT");
        }
        const eligible = contact!.sourceEvents.filter(event =>
          isContactLinkEvidenceIndependent(event, reviewerId) &&
          isContactLinkEvidenceBoundToCandidate(event, fact.candidate));
        if (!eligible.length) throw new Error("CONTACT_LINK_RETAINED_EVIDENCE_UNAVAILABLE");
        eventId = eligible.sort((a, b) => a.eventId - b.eventId)[0].eventId;
      }
      const decisionBusinessId = item.decision === "verified" ? item.businessId : null;
      const decisionKey = reviewDecisionKey({
        contactId: item.contactId,
        businessId: decisionBusinessId,
        decision: item.decision,
        reviewerId,
        expectedRevision: item.expectedRevision,
        snapshotHash: item.snapshotHash,
        evidenceSourceEventId: eventId,
      });
      // An exact committed receipt wins over current-fact freshness. The key
      // binds revision/hash/evidence; the row check binds actor and decision.
      const replay = await findReviewReplay(db, decisionKey, {
        contactId: item.contactId,
        businessId: decisionBusinessId,
        decision: item.decision,
        reviewerId,
        evidenceSourceEventId: eventId,
        expectedRevision: item.expectedRevision,
      });
      if (replay) {
        outcomes.push({ contactId: item.contactId, businessId: decisionBusinessId, ...replay });
        continue;
      }
      const currentCandidate = await verifyCurrentCandidate(db, item);
      if (!currentCandidate) throw new Error("CONTACT_LINK_CANDIDATE_NOT_CURRENT");
      const contact = await fetchSingleContactCoverage(db, item.contactId);
      if (!contact) throw new Error("CRM_OBJECT_NOT_FOUND");
      const fact = candidateFact(item.contactId, item.businessId, [contact]);
      if (!fact) throw new Error("CONTACT_LINK_CANDIDATE_FACTS_UNSUPPORTED");
      if (fact.candidate.snapshotHash !== item.snapshotHash) throw new Error("CONTACT_LINK_CANDIDATE_SNAPSHOT_STALE");
      if (fact.candidate.expectedRevision !== item.expectedRevision) throw new Error("COMMERCIAL_REVISION_CONFLICT");
      if (item.decision === "verified") {
        const evidence = contact.sourceEvents.find(event => event.eventId === eventId);
        if (!evidence) throw new Error("COMMERCIAL_LINK_EVIDENCE_NOT_FOUND");
        if (!isContactLinkEvidenceIndependent(evidence, reviewerId)) {
          throw new Error("COMMERCIAL_LINK_REVIEWER_MUST_BE_INDEPENDENT");
        }
        if (!isContactLinkEvidenceBoundToCandidate(evidence, fact.candidate)) {
          throw new Error("COMMERCIAL_LINK_EVIDENCE_NOT_BOUND_TO_CANDIDATE");
        }
      }
      const decision = await decideContactBusinessLink({
        contactId: item.contactId,
        businessId: decisionBusinessId,
        decision: item.decision,
        decisionKey,
        reviewerId,
        evidenceSourceEventId: eventId,
        expectedRevision: item.expectedRevision,
        authorityCheck: async (tx: any) => {
          const candidateStillCurrent = await verifyCurrentCandidate(tx, item);
          if (!candidateStillCurrent) return false;
          const fresh = await fetchSingleContactCoverage(tx, item.contactId);
          if (!fresh) return false;
          const currentFact = candidateFact(item.contactId, item.businessId, [fresh]);
          return Boolean(currentFact
            && currentFact.candidate.snapshotHash === item.snapshotHash
            && currentFact.candidate.expectedRevision === item.expectedRevision);
        },
      });
      outcomes.push({
        contactId: item.contactId,
        businessId: decisionBusinessId,
        decisionId: String((decision as any).id),
        revision: Number((decision as any).revision),
        status: (decision as any).replayed ? "replayed" : "applied",
      });
    } catch (error: any) {
      const code = String(error?.code ?? error?.message ?? "CONTACT_LINK_REVIEW_FAILED").split("\n")[0].slice(0, 180);
      if (code === "COMMERCIAL_LINK_AUTHORITY_FENCE_LOST") {
        try {
          const decisionBusinessId = item.decision === "verified" ? item.businessId : null;
          const decisionKey = reviewDecisionKey({
            contactId: item.contactId,
            businessId: decisionBusinessId,
            decision: item.decision,
            reviewerId,
            expectedRevision: item.expectedRevision,
            snapshotHash: item.snapshotHash,
            evidenceSourceEventId: eventId,
          });
          const replay = await findReviewReplay(db, decisionKey, {
            contactId: item.contactId,
            businessId: decisionBusinessId,
            decision: item.decision,
            reviewerId,
            evidenceSourceEventId: eventId,
            expectedRevision: item.expectedRevision,
          });
          if (replay) {
            outcomes.push({ contactId: item.contactId, businessId: decisionBusinessId, ...replay });
            continue;
          }
        } catch { /* preserve the original fence result */ }
      }
      outcomes.push({ contactId: item.contactId, businessId: item.businessId, status: "rejected", code });
    }
  }
  return {
    outcomes,
    applied: outcomes.filter(outcome => outcome.status === "applied").length,
    replayed: outcomes.filter(outcome => outcome.status === "replayed").length,
    rejected: outcomes.filter(outcome => outcome.status === "rejected").length,
  };
}
