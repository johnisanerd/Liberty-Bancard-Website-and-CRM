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
export const SFP_VERTICAL_ACCEPTANCE_POLICY_VERSION = 2 as const;

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
  /** Provenance of a retained listing category: the identity-matched provider evidence it came from. */
  sourceRef?: ListingCategorySourceRef;
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

// ── Does the text describe what THIS business does? ──────────────────────────
// Text that merely contains a service word is not support. A statement can deny a service ("we do not
// provide dental services") or name an industry the business serves ("marketing for dental practices",
// "dental software"); neither says the business is in that industry.

const NEGATION_TOKENS = new Set([
  "no", "not", "never", "without", "nor", "neither", "non", "cannot", "except", "excluding", "unlike",
  "unable", "stopped", "ceased", "closed",
]);
const AUDIENCE_PREPOSITIONS = new Set([
  "for", "serving", "serve", "serves", "helping", "helps", "help", "targeting", "supporting", "supports",
  "among", "assist", "assisting",
]);
const AUDIENCE_FILLER = new Set([
  "the", "a", "an", "local", "all", "busy", "independent", "private", "small", "new", "your", "our", "their",
  "growing", "modern", "successful", "established", "every", "other", "fellow", "any", "many", "most", "more",
]);
/** A service word followed by one of these names a vendor to that industry, not a provider in it. */
const VENDOR_FOLLOWERS = new Set([
  "marketing", "seo", "software", "billing", "staffing", "supply", "supplies", "consulting", "consultant",
  "consultants", "lender", "lenders", "lending", "financing", "insurance", "leads", "lead", "websites", "website",
  "design", "coaching", "equipment", "recruiting", "recruiter", "recruiters", "recruitment", "advertising",
  "agency", "agencies", "accounting", "bookkeeping", "payroll", "analytics", "crm", "automation", "management",
  "loans", "brokerage", "franchising", "franchise", "attorney", "attorneys", "lawyer", "lawyers", "law",
  "reviews", "directory", "listings", "vendor", "vendors", "wholesale", "distributor", "distributors",
]);

function clauses(text: string): string[] {
  return text
    .replace(/n['\u2019]t\b/gi, " not")
    .split(/[.;!?:|\n\u2013\u2014]+/u)
    .filter((part) => part.trim().length > 0);
}

function tokensOf(value: string): string[] {
  return normalizeText(value).trim().split(" ").filter(Boolean);
}

function tokenMatches(token: string, phraseToken: string, last: boolean): boolean {
  return token === phraseToken || (last && (token === `${phraseToken}s` || token === `${phraseToken}es`));
}

export type OccurrenceContext = "supports" | "negated" | "audience";

/** Occurrences of a phrase in one clause, each classified by its immediate context. */
export function phraseOccurrences(clause: string, phrase: string): OccurrenceContext[] {
  const tokens = tokensOf(clause);
  const phraseTokens = tokensOf(phrase);
  const found: OccurrenceContext[] = [];
  if (phraseTokens.length === 0) return found;
  for (let i = 0; i + phraseTokens.length <= tokens.length; i++) {
    if (!phraseTokens.every((pt, k) => tokenMatches(tokens[i + k], pt, k === phraseTokens.length - 1))) continue;
    found.push(contextAt(tokens, i, phraseTokens.length));
  }
  return found;
}

function contextAt(tokens: string[], start: number, length: number): OccurrenceContext {
  const before = tokens.slice(Math.max(0, start - 5), start);
  if (before.some((token) => NEGATION_TOKENS.has(token))) return "negated";
  // An audience preposition followed only by filler words right up to the phrase.
  for (let back = start - 1; back >= Math.max(0, start - 4); back--) {
    const token = tokens[back];
    if (AUDIENCE_PREPOSITIONS.has(token)) return "audience";
    if (!AUDIENCE_FILLER.has(token)) break;
  }
  const next = tokens[start + length];
  if (next && VENDOR_FOLLOWERS.has(next)) return "audience";
  return "supports";
}

/** Per-vertical context of every table phrase found in one statement. */
function statementPhraseContexts(
  text: string,
  targets: Set<string>,
): Map<string, { supports: string[]; excluded: OccurrenceContext[] }> {
  const result = new Map<string, { supports: string[]; excluded: OccurrenceContext[] }>();
  for (const clause of clauses(text)) {
    for (const [verticalId, phrases] of Object.entries(WEBSITE_SERVICE_PHRASES)) {
      if (!targets.has(verticalId)) continue;
      for (const phrase of phrases) {
        for (const context of phraseOccurrences(clause, phrase)) {
          const entry = result.get(verticalId) ?? { supports: [], excluded: [] };
          if (context === "supports") entry.supports.push(phrase);
          else entry.excluded.push(context);
          result.set(verticalId, entry);
        }
      }
    }
  }
  return result;
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
    for (const [verticalId, entry] of statementPhraseContexts(statement.text, targets)) {
      if (entry.supports.length > 0) facts.push({ source: "website", field: statement.field, text: statement.text, verticalId });
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

export interface ListingCategorySourceRef {
  /** sfp_paid_candidate_evidence row that retained the category. */
  evidenceId: string;
  provider: string;
  providerOperationId: string | null;
  endpoint: string | null;
}

export interface RetainedListingCategory {
  text: string;
  sourceRef: ListingCategorySourceRef;
}

/**
 * The listing category is the category the provider returned for the identity-matched listing and the
 * retained evidence kept (sfp_paid_candidate_evidence, field listing_category, accepted identity match,
 * not quarantined or discredited). Imported industry text, the legacy vertical label and the business
 * name are not listing categories. A category that maps to one canonical vertical through the
 * versioned classifier tables is accepted; an excluded category next to a target category is a
 * conflict, not a vote.
 */
export interface ListingCategoryInput {
  categories: RetainedListingCategory[];
}

export const NO_LISTING_CATEGORIES: ListingCategoryInput = { categories: [] };

export function decideListingCategoryVertical(
  input: ListingCategoryInput,
  targetIds: string[],
): SourceDecision {
  const facts: SfpAcceptanceFact[] = [];
  let excluded = 0;
  for (const category of input.categories) {
    const label = category.text;
    if (!label || !label.trim()) continue;
    const result = classifyVertical(label, targetIds, 2);
    if ((result.outcome === "resolved_high" || result.outcome === "resolved_medium") && result.matchedTargetId) {
      facts.push({
        source: "listing_category", field: "sfp_paid_candidate_evidence.listing_category", text: label.trim(),
        verticalId: result.matchedTargetId, sourceRef: category.sourceRef,
      });
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
/** Words that make a quote a call to action, navigation or boilerplate rather than a service. */
const BOILERPLATE_TOKENS = new Set([
  "book", "booking", "an", "a", "the", "appointment", "appointments", "schedule", "scheduling", "call", "calls",
  "contact", "us", "today", "now", "free", "estimate", "estimates", "quote", "quotes", "request", "get", "started",
  "learn", "more", "about", "welcome", "to", "home", "our", "team", "hours", "location", "locations", "directions",
  "visit", "we", "are", "open", "click", "here", "online", "form", "submit", "sign", "up", "login", "log", "in",
  "services", "service", "and", "or", "of", "for", "with", "your", "you", "best", "top", "quality", "local",
  "professional", "trusted", "affordable", "family", "owned", "operated", "since", "years", "experience", "reviews",
  "testimonials", "gallery", "blog", "faq", "faqs", "menu", "shop", "store", "privacy", "policy", "terms", "copyright",
  "all", "rights", "reserved", "see", "view", "read", "new", "patients", "customers", "clients", "walk", "ins",
]);

export interface AiCitationVerdict {
  verified: boolean;
  fact?: SfpAcceptanceFact;
  failure?: string;
}

/**
 * An AI vertical qualifies only when it quotes text that (a) is really present in the retained evidence
 * for the source it names, (b) is a service or category description rather than a generic word or a
 * call to action, (c) describes the business's own activity: not negated, not the industry it serves,
 * and (d) does not itself point at a different vertical than the one proposed. The name of the
 * business is never a citable source. For text the phrase tables do not know, the AI's reading of what
 * the service belongs to is relied on; (a)-(d) are the checks the policy can make independently.
 */
export function verifyAiCitation(
  citation: AiCitation,
  proposedVerticalId: string,
  targetIds: string[],
  website: WebsiteClassificationEvidence | null,
  listing: ListingCategoryInput,
): AiCitationVerdict {
  const quote = citation.quote?.trim() ?? "";
  if (!citation.source || !quote) return { verified: false, failure: "AI_CITATION_MISSING" };
  const quoteTokens = tokensOf(quote);
  const normalizedQuote = quoteTokens.join(" ");
  if (normalizedQuote.length < 4 || GENERIC_QUOTES.has(normalizedQuote) ||
      quoteTokens.every((token) => BOILERPLATE_TOKENS.has(token))) {
    return { verified: false, failure: "AI_CITATION_GENERIC" };
  }
  const targets = new Set(targetIds);
  if (citation.source === "website") {
    for (const statement of retainedWebsiteStatements(website)) {
      const verdict = checkQuoteInStatement(statement.text, quoteTokens, proposedVerticalId, targets);
      if (verdict === "absent") continue;
      if (verdict !== "ok") return { verified: false, failure: verdict };
      return { verified: true, fact: { source: "website", field: statement.field, text: statement.text, verticalId: "" } };
    }
    return { verified: false, failure: "AI_CITATION_NOT_IN_WEBSITE_EVIDENCE" };
  }
  for (const category of listing.categories) {
    const verdict = checkQuoteInStatement(category.text, quoteTokens, proposedVerticalId, targets);
    if (verdict === "absent") continue;
    if (verdict !== "ok") return { verified: false, failure: verdict };
    const mapped = classifyVertical(category.text, targetIds, 2);
    if (mapped.outcome === "not_target") return { verified: false, failure: "AI_CITATION_CONTRADICTS_VERTICAL" };
    return {
      verified: true,
      fact: { source: "listing_category", field: "sfp_paid_candidate_evidence.listing_category", text: category.text.trim(),
        verticalId: "", sourceRef: category.sourceRef },
    };
  }
  return { verified: false, failure: "AI_CITATION_NOT_IN_LISTING_CATEGORY" };
}

function checkQuoteInStatement(
  statementText: string,
  quoteTokens: string[],
  proposedVerticalId: string,
  targets: Set<string>,
): "ok" | "absent" | "AI_CITATION_NEGATED" | "AI_CITATION_AUDIENCE_NOT_ACTIVITY" | "AI_CITATION_CONTRADICTS_VERTICAL" {
  let located = false;
  let context: OccurrenceContext = "supports";
  for (const clause of clauses(statementText)) {
    const tokens = tokensOf(clause);
    for (let i = 0; i + quoteTokens.length <= tokens.length; i++) {
      if (!quoteTokens.every((token, k) => tokens[i + k] === token)) continue;
      const found = contextAt(tokens, i, quoteTokens.length);
      if (!located || found !== "supports") context = found;
      located = true;
    }
  }
  if (!located) return "absent";
  if (context === "negated") return "AI_CITATION_NEGATED";
  if (context === "audience") return "AI_CITATION_AUDIENCE_NOT_ACTIVITY";
  // The statement may itself name a different vertical's service (quoting "family dentistry" to
  // support Automotive). Table phrases found anywhere in the statement must not point elsewhere.
  const contexts = statementPhraseContexts(statementText, targets);
  const supported = [...contexts].filter(([, entry]) => entry.supports.length > 0).map(([id]) => id);
  if (supported.length > 0 && !supported.includes(proposedVerticalId)) return "AI_CITATION_CONTRADICTS_VERTICAL";
  if (supported.length === 0 && (contexts.get(proposedVerticalId)?.excluded.length ?? 0) > 0) {
    return contexts.get(proposedVerticalId)!.excluded.includes("negated")
      ? "AI_CITATION_NEGATED" : "AI_CITATION_AUDIENCE_NOT_ACTIVITY";
  }
  return "ok";
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
  targetIds: string[];
}): { decision: SfpAcceptanceDecision; failure?: string } {
  const verified = verifyAiCitation(input.citation, input.verticalId, input.targetIds, input.website, input.listing);
  if (!verified.verified || !verified.fact) return { decision: { kind: "none" }, failure: verified.failure };
  const facts = buildFacts("ai_cited", input.verticalId, [verified.fact], input.website, "ai");
  return { decision: { kind: "accepted", verticalId: input.verticalId, basis: "ai_cited", facts } };
}
