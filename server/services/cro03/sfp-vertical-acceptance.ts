/**
 * Policy-owned acceptance of a business vertical (taxonomy v2).
 *
 * A classification result and the decision to rely on it are different facts. The classifier or the
 * AI proposes a vertical; this policy decides whether the retained supporting facts are strong
 * enough for the effective-vertical reader to use it. One clear, business-specific source is
 * enough:
 *
 *   - website_services    the business's own page describes services of exactly one canonical vertical
 *   - listing_category    the record's listing category maps unambiguously to one canonical vertical
 *   - website_and_listing both agree (both sources are kept)
 *   - ai_cited            the AI proposes a vertical AND quotes service/category text that is really
 *                         present in the retained evidence for the source it names
 *
 * Only a business name, a generic keyword, an unsupported label or a bare confidence score never
 * qualifies, and reliable evidence that points at two verticals records the conflict instead of
 * forcing an assignment. This module is pure: no database, network or provider access.
 */
import { classifyVertical, SFP_TARGET_VERTICALS_V2 } from "./sfp-vertical-classifier";
import type { WebsiteClassificationEvidence } from "./sfp-website-evidence";

/** Bump when the phrase tables or any decision rule below change; it is part of the evidence hash. */
export const SFP_VERTICAL_ACCEPTANCE_POLICY_VERSION = 1 as const;

export type SfpAcceptanceBasis =
  | "website_services"
  | "listing_category"
  | "website_and_listing"
  | "ai_cited";

export type SfpAcceptanceSource = "website" | "listing_category";

export interface SfpAcceptanceFact {
  source: SfpAcceptanceSource;
  /** Where the supporting text came from (page field, JSON-LD type or database column). */
  field: string;
  /** The retained service description or category text that supports the vertical. */
  text: string;
  verticalId: string;
}

export interface SfpAcceptanceFacts {
  policyVersion: typeof SFP_VERTICAL_ACCEPTANCE_POLICY_VERSION;
  basis: SfpAcceptanceBasis;
  verticalId: string;
  facts: SfpAcceptanceFact[];
  /** Fingerprint of the retained website content the decision used, when a website was a source. */
  websiteContentHash: string | null;
  websiteSourceUrl: string | null;
  proposedBy: "policy" | "ai";
}

export type SfpAcceptanceDecision =
  | { kind: "accepted"; verticalId: string; basis: SfpAcceptanceBasis; facts: SfpAcceptanceFacts }
  | { kind: "conflict"; reasonCodes: string[] }
  | { kind: "none" };

// ── Website service phrases ──────────────────────────────────────────────────

/**
 * Specific service or business-type phrases. Every phrase names an activity, never a generic
 * word: "health", "care", "home" or "service" alone must not appear here. Categories the
 * classifier tables exclude (veterinary clinics, pharmacies, restaurants, retail) are absent.
 */
const WEBSITE_SERVICE_PHRASES: Record<string, string[]> = {
  "Healthcare": [
    "dentist", "dental", "dentistry", "orthodontics", "orthodontist", "periodontist", "oral surgeon",
    "chiropractor", "chiropractic", "physical therapy", "physical therapist", "primary care",
    "family medicine", "urgent care", "pediatrics", "pediatrician", "dermatology", "dermatologist",
    "optometrist", "optometry", "ophthalmology", "cardiology", "podiatrist", "podiatry",
    "medical clinic", "medical practice", "medical center", "psychiatrist", "psychologist",
    "audiology", "hearing aids", "occupational therapy", "speech therapy",
  ],
  "Automotive": [
    "auto repair", "automotive repair", "car repair", "collision repair", "auto body", "body shop",
    "oil change", "brake repair", "brake service", "transmission repair", "tire shop", "tires and wheels",
    "wheel alignment", "auto glass", "windshield replacement", "car wash", "auto detailing",
    "car detailing", "auto parts", "auto service", "mechanic", "smog check", "muffler", "window tinting",
  ],
  "Beauty/Spa": [
    "hair salon", "nail salon", "beauty salon", "barber shop", "barbershop", "day spa", "med spa",
    "medspa", "medical spa", "massage therapy", "massage", "waxing", "eyelash extensions",
    "lash extensions", "facials", "facial treatments", "skin care clinic", "hair removal",
    "tanning salon", "microblading", "botox", "cosmetic injectables", "hair stylist", "hair color",
    "manicure", "pedicure", "spa treatments",
  ],
  "Construction/Trades/Home Services": [
    "plumbing", "plumber", "hvac", "air conditioning", "ac repair", "heating and cooling", "roofing",
    "roofer", "electrician", "electrical contractor", "general contractor", "home remodeling",
    "kitchen remodeling", "bathroom remodeling", "painting contractor", "house painting",
    "pressure washing", "pest control", "landscaping", "lawn care", "tree service", "flooring installation",
    "tile installation", "pool service", "pool cleaning", "pool construction", "garage doors",
    "fencing contractor", "concrete contractor", "drywall", "stucco", "impact windows", "hurricane shutters",
    "handyman", "home inspection", "house cleaning", "maid service", "carpet cleaning", "cabinet installation",
    "solar installation", "water damage restoration", "locksmith", "moving company",
  ],
  "Fitness/Recreation": [
    "gym", "fitness center", "fitness studio", "health club", "personal training", "personal trainer",
    "yoga studio", "yoga classes", "pilates", "crossfit", "boxing gym", "martial arts", "karate",
    "jiu jitsu", "brazilian jiu-jitsu", "dance studio", "dance classes", "indoor cycling", "spin classes",
    "bootcamp", "climbing gym", "swim lessons", "tennis club", "recreation center",
  ],
};

/** schema.org types that name one canonical vertical. Generic umbrella types are deliberately absent. */
const JSON_LD_TYPE_VERTICAL: Record<string, string> = {
  dentist: "Healthcare", physician: "Healthcare", medicalclinic: "Healthcare", optician: "Healthcare",
  hospital: "Healthcare", chiropractor: "Healthcare", physiotherapy: "Healthcare",
  autorepair: "Automotive", autobodyshop: "Automotive", autowash: "Automotive", tireshop: "Automotive",
  beautysalon: "Beauty/Spa", hairsalon: "Beauty/Spa", dayspa: "Beauty/Spa", nailsalon: "Beauty/Spa",
  plumber: "Construction/Trades/Home Services", electrician: "Construction/Trades/Home Services",
  hvacbusiness: "Construction/Trades/Home Services", roofingcontractor: "Construction/Trades/Home Services",
  generalcontractor: "Construction/Trades/Home Services", housepainter: "Construction/Trades/Home Services",
  locksmith: "Construction/Trades/Home Services", homeandconstructionbusiness: "Construction/Trades/Home Services",
  exercisegym: "Fitness/Recreation", gymnasium: "Fitness/Recreation", sportsclub: "Fitness/Recreation",
};

function normalizeText(value: string): string {
  return ` ${value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

function normalizedType(type: string): string {
  return type.replace(/^https?:\/\/schema\.org\//i, "").toLowerCase();
}

export interface RetainedWebsiteStatement { field: string; text: string }

/** The retained, human-readable website description fields the policy and the AI both read. */
export function retainedWebsiteStatements(evidence: WebsiteClassificationEvidence | null): RetainedWebsiteStatement[] {
  if (!evidence) return [];
  const statements: RetainedWebsiteStatement[] = [];
  if (evidence.titleText) statements.push({ field: "website.title", text: evidence.titleText });
  if (evidence.metaDescription) statements.push({ field: "website.meta_description", text: evidence.metaDescription });
  for (const heading of evidence.headings ?? []) statements.push({ field: "website.heading", text: heading });
  return statements;
}

type SourceDecision =
  | { kind: "single"; verticalId: string; facts: SfpAcceptanceFact[] }
  | { kind: "conflict"; verticalIds: string[]; facts: SfpAcceptanceFact[] }
  | { kind: "none" };

export function decideWebsiteVertical(
  evidence: WebsiteClassificationEvidence | null,
  targetIds: string[],
): SourceDecision {
  if (!evidence) return { kind: "none" };
  const facts: SfpAcceptanceFact[] = [];
  const targets = new Set(targetIds);
  for (const statement of retainedWebsiteStatements(evidence)) {
    const haystack = normalizeText(statement.text);
    for (const [verticalId, phrases] of Object.entries(WEBSITE_SERVICE_PHRASES)) {
      if (!targets.has(verticalId)) continue;
      const phrase = phrases.find((candidate) => haystack.includes(normalizeText(candidate)));
      if (phrase) facts.push({ source: "website", field: statement.field, text: statement.text, verticalId });
    }
  }
  for (const type of evidence.jsonLdTypes) {
    const verticalId = JSON_LD_TYPE_VERTICAL[normalizedType(type)];
    if (verticalId && targets.has(verticalId)) {
      facts.push({ source: "website", field: "website.json_ld_type", text: type, verticalId });
    }
  }
  const verticalIds = [...new Set(facts.map((fact) => fact.verticalId))];
  if (verticalIds.length === 0) return { kind: "none" };
  if (verticalIds.length > 1) return { kind: "conflict", verticalIds, facts };
  return { kind: "single", verticalId: verticalIds[0], facts: dedupeFacts(facts) };
}

function dedupeFacts(facts: SfpAcceptanceFact[]): SfpAcceptanceFact[] {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    const key = `${fact.field}|${fact.text}|${fact.verticalId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface ListingCategoryInput {
  structuredVertical: string | null;
  industryPrimary: string | null;
  industrySecondary: string | null;
}

/**
 * The listing category is the structured category carried by the canonical business record. A name
 * is never a listing category. A label that maps to one canonical vertical through the versioned
 * classifier tables (exact alias or curated strong synonym) is accepted; an excluded category next
 * to a target category is a conflict, not a vote.
 */
export function decideListingCategoryVertical(
  input: ListingCategoryInput,
  targetIds: string[],
): SourceDecision {
  const fields: Array<[string, string | null]> = [
    ["businesses.vertical", input.structuredVertical],
    ["businesses.industry_primary", input.industryPrimary],
    ["businesses.industry_secondary", input.industrySecondary],
  ];
  const facts: SfpAcceptanceFact[] = [];
  let excluded = 0;
  for (const [field, label] of fields) {
    if (!label || !label.trim()) continue;
    const result = classifyVertical(label, targetIds, 2);
    if ((result.outcome === "resolved_high" || result.outcome === "resolved_medium") && result.matchedTargetId) {
      facts.push({ source: "listing_category", field, text: label.trim(), verticalId: result.matchedTargetId });
    } else if (result.outcome === "not_target") {
      excluded++;
    }
  }
  const verticalIds = [...new Set(facts.map((fact) => fact.verticalId))];
  if (verticalIds.length === 0) return { kind: "none" };
  if (verticalIds.length > 1 || excluded > 0) return { kind: "conflict", verticalIds, facts };
  return { kind: "single", verticalId: verticalIds[0], facts };
}

export interface AiCitation {
  source: SfpAcceptanceSource | null;
  quote: string | null;
}

const GENERIC_QUOTES = new Set([
  "health", "healthcare", "care", "home", "service", "services", "spa", "center", "centre", "studio",
  "shop", "store", "business", "company", "professional", "quality", "local", "family", "wellness",
  "repair", "beauty", "fitness", "auto", "automotive", "construction", "contractor", "contractors",
]);

/**
 * An AI vertical qualifies only when it quotes text that is really present in the retained evidence
 * for the source it names, and the quote is more than a generic word. The name of the business is
 * never a citable source.
 */
export function verifyAiCitation(
  citation: AiCitation,
  website: WebsiteClassificationEvidence | null,
  listing: ListingCategoryInput,
): { verified: boolean; fact?: SfpAcceptanceFact; failure?: string } {
  const quote = citation.quote?.trim() ?? "";
  if (!citation.source || !quote) return { verified: false, failure: "AI_CITATION_MISSING" };
  const normalizedQuote = normalizeText(quote).trim();
  if (normalizedQuote.length < 4 || GENERIC_QUOTES.has(normalizedQuote)) {
    return { verified: false, failure: "AI_CITATION_GENERIC" };
  }
  const needle = ` ${normalizedQuote} `;
  if (citation.source === "website") {
    for (const statement of retainedWebsiteStatements(website)) {
      if (normalizeText(statement.text).includes(needle)) {
        return { verified: true, fact: { source: "website", field: statement.field, text: statement.text, verticalId: "" } };
      }
    }
    return { verified: false, failure: "AI_CITATION_NOT_IN_WEBSITE_EVIDENCE" };
  }
  for (const [field, label] of [
    ["businesses.vertical", listing.structuredVertical],
    ["businesses.industry_primary", listing.industryPrimary],
    ["businesses.industry_secondary", listing.industrySecondary],
  ] as Array<[string, string | null]>) {
    if (label && normalizeText(label).includes(needle)) {
      return { verified: true, fact: { source: "listing_category", field, text: label.trim(), verticalId: "" } };
    }
  }
  return { verified: false, failure: "AI_CITATION_NOT_IN_LISTING_CATEGORY" };
}

function buildFacts(
  basis: SfpAcceptanceBasis,
  verticalId: string,
  facts: SfpAcceptanceFact[],
  website: WebsiteClassificationEvidence | null,
  proposedBy: "policy" | "ai",
): SfpAcceptanceFacts {
  const usesWebsite = facts.some((fact) => fact.source === "website");
  return {
    policyVersion: SFP_VERTICAL_ACCEPTANCE_POLICY_VERSION,
    basis,
    verticalId,
    facts: facts.map((fact) => ({ ...fact, verticalId })),
    websiteContentHash: usesWebsite && website ? website.contentHash : null,
    websiteSourceUrl: usesWebsite && website ? website.sourceUrl : null,
    proposedBy,
  };
}

/**
 * Deterministic part of the policy (no AI): website description and listing category.
 * Conflicting reliable evidence is reported, never resolved by picking one source.
 */
export function decideDeterministicAcceptance(input: {
  website: WebsiteClassificationEvidence | null;
  listing: ListingCategoryInput;
  targetIds: string[];
}): SfpAcceptanceDecision {
  const targets = input.targetIds.filter((id) => (SFP_TARGET_VERTICALS_V2 as readonly string[]).includes(id));
  const website = decideWebsiteVertical(input.website, targets);
  const listing = decideListingCategoryVertical(input.listing, targets);

  if (website.kind === "conflict") {
    return { kind: "conflict", reasonCodes: [`ACCEPTANCE_CONFLICT:website_services:${website.verticalIds.join("|")}`] };
  }
  if (listing.kind === "conflict") {
    return { kind: "conflict", reasonCodes: [`ACCEPTANCE_CONFLICT:listing_category:${listing.verticalIds.join("|")}`] };
  }
  if (website.kind === "single" && listing.kind === "single") {
    if (website.verticalId !== listing.verticalId) {
      return {
        kind: "conflict",
        reasonCodes: [`ACCEPTANCE_CONFLICT:website_vs_listing:${website.verticalId}|${listing.verticalId}`],
      };
    }
    const facts = buildFacts("website_and_listing", website.verticalId, [...website.facts, ...listing.facts], input.website, "policy");
    return { kind: "accepted", verticalId: website.verticalId, basis: "website_and_listing", facts };
  }
  if (website.kind === "single") {
    const facts = buildFacts("website_services", website.verticalId, website.facts, input.website, "policy");
    return { kind: "accepted", verticalId: website.verticalId, basis: "website_services", facts };
  }
  if (listing.kind === "single") {
    const facts = buildFacts("listing_category", listing.verticalId, listing.facts, null, "policy");
    return { kind: "accepted", verticalId: listing.verticalId, basis: "listing_category", facts };
  }
  return { kind: "none" };
}

/** Accept an AI proposal only through a verified citation; otherwise the proposal stays raw. */
export function decideAiAcceptance(input: {
  verticalId: string;
  citation: AiCitation;
  website: WebsiteClassificationEvidence | null;
  listing: ListingCategoryInput;
}): { decision: SfpAcceptanceDecision; failure?: string } {
  const verified = verifyAiCitation(input.citation, input.website, input.listing);
  if (!verified.verified || !verified.fact) return { decision: { kind: "none" }, failure: verified.failure };
  const facts = buildFacts("ai_cited", input.verticalId, [verified.fact], input.website, "ai");
  return { decision: { kind: "accepted", verticalId: input.verticalId, basis: "ai_cited", facts } };
}
