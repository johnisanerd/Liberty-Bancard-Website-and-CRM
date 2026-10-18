import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import {
  applyCertificationProviderDenyBoundary,
  getBlockedCertificationNetworkAttemptCount,
} from "../certification-provider-deny";

await assertDisposableTestInfrastructure({ operation: "vertical acceptance policy certification" });
process.env.VG_PROVIDER_DENY_MODE = "1";
applyCertificationProviderDenyBoundary({ fatal: true });

const { pool } = await import("../../server/db");
const { runPreCohortClassificationBridge } = await import("../../server/services/cro03/sfp-classification-bridge");
const { contentHashOf } = await import("../../server/services/cro03/sfp-website-evidence");
const { SFP_TARGET_VERTICALS_V2 } = await import("../../server/services/cro03/sfp-vertical-classifier");
const accept = await import("../../server/services/cro03/sfp-vertical-acceptance");
const { seal } = await import("../../server/services/cro03/candidate-evidence-service");
const { loadRetainedListingCategories } = await import("../../server/services/cro03/sfp-retained-listing-category");
const { sfpInputFingerprint } = await import("../../server/services/cro03/sfp-input-fingerprint");
const { sfpInputFingerprintSql } = await import("../../shared/sfp-input-fingerprint");
const { effectiveBusinessVerticalSql, effectiveBusinessVerticalStatusSql } = await import("../../shared/effective-vertical");
const { validateSfpAiVerticalResult, sfpAiVerticalResponseSchema } = await import("../../server/services/cro03/sfp-ai-vertical-result");
const { prepareCanonicalRecipient } = await import("../../server/services/canonical-recipient-preparation");
const { previewContactBusinessSystemLinks, applyContactBusinessSystemLink } =
  await import("../../server/services/contact-business-system-links");

const targetIds = [...SFP_TARGET_VERTICALS_V2] as string[];
const prefix = `cert_vertical_acceptance_${randomUUID().replaceAll("-", "")}`;
const actor = { role: "admin" as const, actorId: `system:${prefix}`, email: null };
let checks = 0;
const check = (value: unknown, message: string) => { assert(value, message); checks++; };

// ── pure policy ─────────────────────────────────────────────────────────────
type Page = { title?: string; meta?: string; headings?: string[]; jsonLd?: string[] };
function pageEvidence(domain: string, page: Page) {
  const body = {
    jsonLdTypes: page.jsonLd ?? [], titleTokens: [], metaTokens: [], serviceTokens: [], categoryTokens: [],
    pageType: "unknown", titleText: page.title ?? "", metaDescription: page.meta ?? "", headings: page.headings ?? [],
  };
  return {
    sourceUrl: `https://${domain}/`, ...body, capturedAt: new Date().toISOString(), contentHash: contentHashOf(body),
  };
}
const noListing = { categories: [] as any[] };
const ref = { evidenceId: "00000000-0000-0000-0000-000000000001", provider: "serper", providerOperationId: null, endpoint: "maps" };
const L = (...texts: string[]) => ({ categories: texts.map((text, i) => ({ text, sourceRef: { ...ref, evidenceId: `00000000-0000-0000-0000-00000000000${i + 1}` } })) });
{
  const dental = pageEvidence("pure.test", { title: "Bright Smile Dental", headings: ["Family dentistry"] });
  const d = accept.decideDeterministicAcceptance({ website: dental, listing: noListing, targetIds });
  check(d.kind === "accepted" && d.verticalId === "Healthcare" && d.basis === "website_services",
    "A business's own page describing dentistry is accepted as Healthcare from the website alone");
  check(d.kind === "accepted" && d.facts.facts.every((f) => f.text.length > 0 && f.field.startsWith("website")) &&
    d.facts.websiteContentHash === dental.contentHash && d.facts.policyVersion === accept.SFP_VERTICAL_ACCEPTANCE_POLICY_VERSION,
    "Accepted facts keep the source reference, service description, content fingerprint and policy version");
  const healthWord = pageEvidence("pure.test", { title: "Mind Body Health", meta: "Your health and home care matters" });
  check(accept.decideDeterministicAcceptance({ website: healthWord, listing: noListing, targetIds }).kind === "none",
    "The isolated word 'health' never supports Healthcare");
  const mixed = pageEvidence("pure.test", { title: "Dental implants and plumbing repair" });
  const m = accept.decideDeterministicAcceptance({ website: mixed, listing: noListing, targetIds });
  check(m.kind === "conflict" && m.reasonCodes[0].startsWith("ACCEPTANCE_CONFLICT:website_services:"),
    "A page describing two verticals records the specific conflict instead of picking one");
  const jsonLd = pageEvidence("pure.test", { jsonLd: ["AutoRepair"] });
  check(accept.decideDeterministicAcceptance({ website: jsonLd, listing: noListing, targetIds }).kind === "accepted",
    "A specific structured business type on the page is a clear website source");
  const umbrella = pageEvidence("pure.test", { jsonLd: ["LocalBusiness", "Organization", "AutomotiveBusiness"] });
  check(accept.decideDeterministicAcceptance({ website: umbrella, listing: noListing, targetIds }).kind === "none",
    "Generic umbrella types do not qualify");
  const listing = accept.decideDeterministicAcceptance({
    website: null, listing: L("Dentist"), targetIds });
  check(listing.kind === "accepted" && listing.basis === "listing_category" && listing.verticalId === "Healthcare",
    "An identity-matched listing category that maps to one vertical is accepted with no AI call");
  const vs = accept.decideDeterministicAcceptance({
    website: dental, listing: L("Plumbing"), targetIds });
  check(vs.kind === "conflict" && vs.reasonCodes[0].startsWith("ACCEPTANCE_CONFLICT:website_vs_listing:"),
    "Website and listing disagreement is a recorded conflict");
  const both = accept.decideDeterministicAcceptance({
    website: dental, listing: L("Dentist"), targetIds });
  check(both.kind === "accepted" && both.basis === "website_and_listing" &&
    both.facts.facts.some((f) => f.source === "website") && both.facts.facts.some((f) => f.source === "listing_category"),
    "Agreement accepts and retains both sources");
  const nameOnly = accept.decideDeterministicAcceptance({
    website: null, listing: L("Services"), targetIds });
  check(nameOnly.kind === "none", "An unsupported or generic label is retained as a suggestion, never accepted");
  const ai = accept.decideAiAcceptance({ verticalId: "Healthcare", citation: { source: "website", quote: "Family   DENTISTRY" },
    website: dental, listing: noListing, targetIds });
  check(ai.decision.kind === "accepted" && ai.decision.basis === "ai_cited", "An AI proposal with a verifiable quote is accepted by the policy");
  check(accept.decideAiAcceptance({ verticalId: "Healthcare", citation: { source: "website", quote: "Dental implants" },
    website: dental, listing: noListing, targetIds }).failure === "AI_CITATION_NOT_IN_WEBSITE_EVIDENCE",
    "A quote that is not in the retained evidence is rejected");
  check(accept.decideAiAcceptance({ verticalId: "Healthcare", citation: { source: "website", quote: "health" },
    website: healthWord, listing: noListing, targetIds }).failure === "AI_CITATION_GENERIC", "A generic quote is rejected");
  check(accept.decideAiAcceptance({ verticalId: "Healthcare", citation: { source: null, quote: null },
    website: dental, listing: noListing, targetIds }).failure === "AI_CITATION_MISSING", "A bare AI target without a citation is rejected");
  // Reported counterexamples: text on a page is not support unless it describes this business's activity.
  const aiOn = (page: Page, verticalId: string, quote: string) => accept.decideAiAcceptance({
    verticalId, citation: { source: "website", quote }, website: pageEvidence("pure.test", page), listing: noListing, targetIds });
  check(aiOn({ title: "Sunrise Studio", headings: ["Book an appointment"] }, "Healthcare", "Book an appointment").failure === "AI_CITATION_GENERIC",
    "A call-to-action quote ('Book an appointment') is never support");
  check(aiOn({ title: "Sunrise Studio", headings: ["Family dentistry"] }, "Automotive", "Family dentistry").failure === "AI_CITATION_CONTRADICTS_VERTICAL",
    "A quote that describes dentistry cannot support Automotive");
  check(aiOn({ title: "Harbor Clinic", headings: ["We do not provide dental services"] }, "Healthcare", "dental services").failure === "AI_CITATION_NEGATED",
    "A denied service is not support");
  check(aiOn({ title: "Harbor Media", headings: ["Marketing services for dental practices"] }, "Healthcare", "dental practices").failure === "AI_CITATION_AUDIENCE_NOT_ACTIVITY",
    "An industry the business serves is not the business's activity");
  check(aiOn({ title: "Harbor Clinic", headings: ["Dental implants and cleanings"] }, "Healthcare", "Dental implants").decision.kind === "accepted",
    "A service quote that is the business's own activity is still accepted from one source");
  for (const [heading, label] of [
    ["We don't offer dentistry", "contraction negation"], ["No dental services available", "no-negation"],
    ["Dental software for practices", "vendor of dental software"], ["SEO for plumbers", "SEO vendor"],
    ["Staffing for dental offices", "staffing vendor"], ["Supplies for auto repair shops", "supplies vendor"],
  ] as const) {
    const d = accept.decideDeterministicAcceptance({ website: pageEvidence("pure.test", { title: "Acme", headings: [heading] }), listing: noListing, targetIds });
    check(d.kind === "none", `Deterministic matching ignores ${label}: "${heading}"`);
  }
  for (const heading of ["Welcome to our dental practice", "Dentists for the whole family", "Plumbing services for homes", "Auto repair and oil changes"]) {
    const d = accept.decideDeterministicAcceptance({ website: pageEvidence("pure.test", { title: "Acme", headings: [heading] }), listing: noListing, targetIds });
    check(d.kind === "accepted", `Genuine activity is still accepted: "${heading}"`);
  }
  check(accept.decideDeterministicAcceptance({ website: null, listing: L("Dentist"), targetIds }).kind === "accepted" &&
    accept.decideDeterministicAcceptance({ website: null, listing: noListing, targetIds }).kind === "none",
    "Only retained listing categories count as the listing source");
  const withSource = accept.decideDeterministicAcceptance({ website: null, listing: L("Auto repair shop"), targetIds });
  check(withSource.kind === "accepted" && withSource.facts.facts[0].sourceRef?.provider === "serper" &&
    withSource.facts.facts[0].sourceRef?.evidenceId === "00000000-0000-0000-0000-000000000001", "The accepted fact keeps the retained evidence provenance");
  const schemaProps = Object.keys((sfpAiVerticalResponseSchema(targetIds).schema as any).properties);
  check(schemaProps.includes("evidenceQuote") && schemaProps.includes("evidenceSource"), "The AI response schema asks for a citation");
  const legacy = validateSfpAiVerticalResult({ outcome: "target", confidence: 0.9, reasonCodes: [], resolvedVerticalId: "Healthcare" }, targetIds);
  check(legacy?.evidenceQuote === null, "Stored legacy four-key AI receipts still validate, with no citation");
}

// ── fingerprint parity (TypeScript vs SQL) ──────────────────────────────────
for (const f of [
  { vertical: null, industryPrimary: null, industrySecondary: null },
  { vertical: "Dental", industryPrimary: "Café – dentist ünïcode", industrySecondary: "" },
]) {
  const row = (await pool.query(
    `SELECT ${sfpInputFingerprintSql("b")} AS fp FROM (SELECT -1::int AS id,$1::text AS vertical,$2::text AS industry_primary,$3::text AS industry_secondary) b`,
    [f.vertical, f.industryPrimary, f.industrySecondary])).rows[0];
  check(row.fp === sfpInputFingerprint(f), "The TypeScript and SQL input fingerprints are byte-identical");
}

// ── bridge + readers + preparation ──────────────────────────────────────────
const programId = randomUUID();
await pool.query(`INSERT INTO sfp_programs (id,name,county_fips,vertical_ids,taxonomy_version,is_active,created_by)
  VALUES($1,$2,ARRAY['12086'],$3::text[],2,TRUE,$4)`, [programId, prefix, targetIds, actor.actorId]);
const policyVersion = Number((await pool.query("SELECT policy_version FROM sfp_programs WHERE id=$1", [programId])).rows[0].policy_version);
const sequenceId = Number((await pool.query(`INSERT INTO follow_up_sequences
  (name,status,trigger_type,trigger_config) VALUES($1,'paused','contact_created',$2::jsonb) RETURNING id`,
  [prefix, JSON.stringify({ canonicalProgramId: programId, canonicalVerticals: targetIds })])).rows[0].id);

async function retain(businessId: number, text: string, match = true): Promise<string> {
  const sealed = seal("listing_category", text);
  return String((await pool.query(`INSERT INTO sfp_paid_candidate_evidence
    (business_id,provider,field,subject_type,disposition,confidence,envelope_ciphertext,envelope_nonce,envelope_tag,envelope_key_version,
     normalized_value_hash,masked_value,candidate_metadata)
    VALUES($1,'serper','listing_category','business','staged',80,$2,$3,$4,1,$5,$6,$7::jsonb) RETURNING id`,
    [businessId, sealed.ciphertext, sealed.nonce, sealed.tag, sealed.normalizedValueHash, sealed.maskedValue,
     JSON.stringify({ acceptedIdentityMatch: match, endpoint: "maps", strategy: "certification" })])).rows[0].id);
}
async function business(label: string, o: { domain?: string; primary?: string; name?: string; industry?: string; vertical?: string } = {}) {
  const place = `${prefix}_${label}_place`;
  const row = (await pool.query(`INSERT INTO businesses
    (canonical_name,normalized_name,record_class,google_place_id,vertical,industry_primary,website_domain,city,state,postal_code)
    VALUES($1,$2,'canonical',$3,$6,$4,$5,'Miami','FL','33130') RETURNING id`,
    [o.name ?? `${prefix} ${label}`, `${prefix}${label}`, place, o.industry ?? null, o.domain ?? null, o.vertical ?? null])).rows[0];
  if (o.primary) await retain(Number(row.id), o.primary);
  await pool.query(`INSERT INTO business_locations (business_id,is_primary,city,state,postal_code,county_fips)
    VALUES($1,true,'Miami','FL','33130','12086')`, [row.id]);
  await pool.query(`INSERT INTO canonical_source_links (business_id,source_system,source_type,stable_key)
    VALUES($1,'google_maps','place',$2)`, [row.id, place]);
  return Number(row.id);
}
const pages = new Map<string, Page | { error: string }>();
const aiCalls: number[] = [];
const aiResults = new Map<number, any>();
let runNo = 0;
async function classify(ids: number[]) {
  const extractWebsiteEvidence = async (url: string) => {
    const domain = new URL(url).hostname;
    const page = pages.get(domain);
    if (!page) return { error: "fetch_failed" };
    if ("error" in page) return page;
    return pageEvidence(domain, page);
  };
  const openAiClassify = async (input: { businessId: number }) => {
    aiCalls.push(input.businessId);
    return aiResults.get(input.businessId) ?? null;
  };
  return runPreCohortClassificationBridge({
    programId, idempotencyKey: `${prefix}:run:${++runNo}`, actorId: actor.actorId, maxBusinesses: 100, targetIds,
    policyVersion, taxonomyVersion: 2, businessIdFilter: ids, allowWebsiteEvidenceFetch: true,
  }, { extractWebsiteEvidence, openAiClassify } as any);
}
async function latest(id: number) {
  return (await pool.query(`SELECT * FROM sfp_classification_evidence WHERE business_id=$1
    AND terminal_state='completed' ORDER BY created_at DESC,id DESC LIMIT 1`, [id])).rows[0];
}
async function allRows(id: number) {
  return (await pool.query("SELECT * FROM sfp_classification_evidence WHERE business_id=$1 ORDER BY created_at,id", [id])).rows;
}
async function effective(id: number) {
  return (await pool.query(`SELECT ${effectiveBusinessVerticalSql("b")} AS v,${effectiveBusinessVerticalStatusSql("b")} AS s
    FROM businesses b WHERE b.id=$1`, [id])).rows[0] as { v: string | null; s: string };
}

pages.set("web-only.example.test", { title: "Bright Smile Dental | Family Dentistry in Miami", headings: ["Cosmetic dentistry", "Teeth whitening"] });
pages.set("both.example.test", { title: "Studio Luxe", headings: ["Hair stylist and day spa"] });
pages.set("conflict.example.test", { title: "Dental implants for every smile" });
pages.set("ai-valid.example.test", { title: "Coastal Care", headings: ["Gait analysis and orthotic fittings"] });
pages.set("ai-invalid.example.test", { title: "Coastal Care Two", headings: ["Gait analysis and orthotic fittings"] });
pages.set("ai-generic.example.test", { title: "Wellbeing", meta: "Health" });
pages.set("fetch-fail.example.test", { error: "fetch_failed" });

const webOnly = await business("web", { domain: "web-only.example.test" });
const listingOnly = await business("listing", { primary: "Auto Repair" });
const both = await business("both", { domain: "both.example.test", primary: "Hair Salon" });
const conflict = await business("conflict", { domain: "conflict.example.test", primary: "Plumbing" });
const nameOnly = await business("nameonly", { name: `${prefix} Health Partners Group` });
const aiValid = await business("aivalid", { domain: "ai-valid.example.test" });
const aiInvalid = await business("aiinvalid", { domain: "ai-invalid.example.test" });
const aiGeneric = await business("aigeneric", { domain: "ai-generic.example.test" });
const fetchFail = await business("fetchfail", { domain: "fetch-fail.example.test" });
aiResults.set(aiValid, { outcome: "target", confidence: 0.8, reasonCodes: ["TEST_AI"], resolvedVerticalId: "Healthcare",
  evidenceSource: "website", evidenceQuote: "gait analysis", modelVersion: "test", promptVersion: "test", costMicros: 0 });
aiResults.set(aiInvalid, { outcome: "target", confidence: 0.99, reasonCodes: ["TEST_AI"], resolvedVerticalId: "Healthcare",
  evidenceSource: "website", evidenceQuote: "dental implants", modelVersion: "test", promptVersion: "test", costMicros: 0 });
aiResults.set(aiGeneric, { outcome: "target", confidence: 0.99, reasonCodes: ["TEST_AI"], resolvedVerticalId: "Healthcare",
  evidenceSource: "website", evidenceQuote: "health", modelVersion: "test", promptVersion: "test", costMicros: 0 });
aiResults.set(nameOnly, { outcome: "target", confidence: 0.99, reasonCodes: ["TEST_AI"], resolvedVerticalId: "Healthcare",
  evidenceSource: null, evidenceQuote: null, modelVersion: "test", promptVersion: "test", costMicros: 0 });
const all = [webOnly, listingOnly, both, conflict, nameOnly, aiValid, aiInvalid, aiGeneric, fetchFail];
const opsBefore = Number((await pool.query("SELECT count(*)::int n FROM provider_operations")).rows[0].n);

await classify(all);

let row = await latest(webOnly);
check(row.outcome === "target" && row.admission_tier === "policy_accepted" && row.acceptance_basis === "website_services" &&
  row.resolved_vertical_id === "Healthcare", "Website-only evidence yields an accepted vertical");
check(row.acceptance_policy_version === accept.SFP_VERTICAL_ACCEPTANCE_POLICY_VERSION && row.website_content_hash &&
  row.acceptance_facts.facts[0].text && row.acceptance_facts.websiteContentHash === row.website_content_hash &&
  row.input_fingerprint, "The acceptance record stores source reference, description, content fingerprint, proposed vertical and policy version");
check(!aiCalls.includes(webOnly) && !aiCalls.includes(listingOnly) && !aiCalls.includes(both) && !aiCalls.includes(conflict),
  "Clear single-source and conflicting cases never need an AI call");
row = await latest(listingOnly);
check(row.admission_tier === "policy_accepted" && row.acceptance_basis === "listing_category" && row.resolved_vertical_id === "Automotive",
  "Listing-category-only evidence yields an accepted vertical");
row = await latest(both);
check(row.acceptance_basis === "website_and_listing" && row.resolved_vertical_id === "Beauty/Spa" &&
  row.acceptance_facts.facts.length >= 2, "Agreeing website and listing are both retained");
row = await latest(conflict);
check(row.outcome === "review_required" && row.admission_tier === null && row.resolved_vertical_id === null &&
  JSON.stringify(row.reason_codes).includes("ACCEPTANCE_CONFLICT:website_vs_listing"), "Conflicting reliable evidence records the specific conflict and assigns nothing");
check((await effective(conflict)).s === "conflicting" && (await effective(conflict)).v === null, "A conflict reads as conflicting and has no effective vertical");
row = await latest(nameOnly);
check(!row || (row.admission_tier === null && row.outcome !== "non_target"), "A company name alone is not accepted and not excluded");
const nameRows = await allRows(nameOnly);
check(nameRows.length === 1 && nameRows[0].outcome === "target" && nameRows[0].admission_tier === null &&
  JSON.stringify(nameRows[0].reason_codes).includes("AI_CITATION_MISSING"),
  "An uncited AI target is retained as the AI's raw result but not accepted");
check((await effective(nameOnly)).v === null, "The effective-vertical reader does not use an unaccepted AI target");
row = await latest(aiValid);
check(row.admission_tier === "policy_accepted" && row.acceptance_basis === "ai_cited" && row.model_version === "test" &&
  row.outcome === "target", "An AI target with a verifiable quote is accepted by the policy, keeping the AI's own result distinct");
row = await latest(aiInvalid);
check(row.outcome === "target" && row.admission_tier === null && JSON.stringify(row.reason_codes).includes("AI_CITATION_NOT_IN_WEBSITE_EVIDENCE"),
  "A fabricated citation is not accepted even at 0.99 confidence");
row = await latest(aiGeneric);
check(row.admission_tier === null && JSON.stringify(row.reason_codes).includes("AI_CITATION_GENERIC"), "A generic quote is not accepted");
const failRows = await allRows(fetchFail);
check(failRows.length === 1 && failRows[0].terminal_state === "provisional" && failRows[0].outcome === "review_required" &&
  JSON.stringify(failRows[0].reason_codes).includes("WEBSITE_EVIDENCE_UNAVAILABLE:fetch_failed"),
  "A failed website fetch is recorded as unavailable evidence, never as non-target, and stays retryable");
check((await effective(webOnly)).v === "Healthcare" && (await effective(webOnly)).s === "mapped" &&
  (await effective(listingOnly)).v === "Automotive" && (await effective(aiValid)).v === "Healthcare",
  "The effective-vertical reader uses the accepted decisions");

// Recovery: the site becomes reachable, and the same business is reconsidered automatically.
pages.set("fetch-fail.example.test", { title: "Quick Lube", headings: ["Oil change and brake repair"] });
await classify([fetchFail]);
row = await latest(fetchFail);
check(row.admission_tier === "policy_accepted" && row.resolved_vertical_id === "Automotive", "A previously unreachable site is accepted on the next pass with no manual step");

// Unchanged evidence is reused, not re-evaluated.
const rowsBeforeRerun = (await allRows(webOnly)).length;
await classify([webOnly, listingOnly]);
check((await allRows(webOnly)).length === rowsBeforeRerun, "Unchanged evidence is reused: no new row and no repeated work");

// Changed evidence supersedes an old acceptance, and reverting restores it.
const autoRepairEvidence = (await pool.query(`SELECT id FROM sfp_paid_candidate_evidence WHERE business_id=$1 AND field='listing_category'`, [listingOnly])).rows[0].id;
await pool.query("INSERT INTO sfp_discredited_paid_evidence (evidence_id,business_id,reason_code) VALUES($1,$2,'certification')", [autoRepairEvidence, listingOnly]);
await retain(listingOnly, "Hair Salon");
check((await effective(listingOnly)).v === null, "A changed listing category immediately supersedes the old acceptance");
await classify([listingOnly]);
row = await latest(listingOnly);
check(row.resolved_vertical_id === "Beauty/Spa" && row.acceptance_basis === "listing_category", "Changed evidence is reconsidered automatically and re-accepted");
check((await effective(listingOnly)).v === "Beauty/Spa", "The reader follows the newest accepted decision");
await pool.query("DELETE FROM sfp_discredited_paid_evidence WHERE evidence_id=$1", [autoRepairEvidence]);
await pool.query("INSERT INTO sfp_discredited_paid_evidence (evidence_id,business_id,reason_code) SELECT id,business_id,'certification' FROM sfp_paid_candidate_evidence WHERE business_id=$1 AND normalized_value_hash<>(SELECT normalized_value_hash FROM sfp_paid_candidate_evidence WHERE id=$2)", [listingOnly, autoRepairEvidence]);
const beforeRevert = (await allRows(listingOnly)).length;
await classify([listingOnly]);
const afterRevert = await allRows(listingOnly);
check(afterRevert.length === beforeRevert + 1 && JSON.stringify(afterRevert.at(-1).reason_codes).includes("REAFFIRMED_PRIOR_EVIDENCE") &&
  Number(afterRevert.at(-1).cost_micros) === 0,
  "Reverting to inputs seen before re-records the unchanged decision as the latest row without new work");
check((await effective(listingOnly)).v === "Automotive", "The restored decision is effective again");
await pool.query("UPDATE businesses SET website_domain='other.example.test' WHERE id=$1", [webOnly]);
check((await effective(webOnly)).v === null, "A website-based acceptance is superseded when the business's domain changes");
await pool.query("UPDATE businesses SET website_domain='web-only.example.test' WHERE id=$1", [webOnly]);
check((await effective(webOnly)).v === "Healthcare", "...and is current again when the same domain returns");
await pool.query("UPDATE businesses SET website_domain='filled.example.test' WHERE id=$1", [listingOnly]);
check((await effective(listingOnly)).v === "Automotive", "Enrichment filling a missing domain does not invalidate a listing-based acceptance");

// ── Review counterexamples through the bridge ─────────────────────────────────
const { CLASSIFIER_VERSION } = await import("../../server/services/cro03/sfp-vertical-classifier");
const { processSfpFreeClassificationTick } = await import("../../server/services/cro03/sfp-free-classification-continuation");
const aiQuote = (businessId: number, verticalId: string, quote: string) =>
  aiResults.set(businessId, { outcome: "target", confidence: 0.99, reasonCodes: ["TEST_AI"], resolvedVerticalId: verticalId,
    evidenceSource: "website", evidenceQuote: quote, modelVersion: "test", promptVersion: "test", costMicros: 0 });
pages.set("cta.example.test", { title: "Sunrise Studio", headings: ["Book an appointment"] });
pages.set("negated.example.test", { title: "Harbor Clinic", headings: ["We do not provide dental services"] });
pages.set("audience.example.test", { title: "Harbor Media", headings: ["Marketing services for dental practices"] });
pages.set("label-conflict.example.test", { title: "Quick Lube", headings: ["Oil change and brake repair"] });
pages.set("label-agree.example.test", { title: "Smile", headings: ["Family dentistry"] });
const cta = await business("cta", { domain: "cta.example.test" });
const negated = await business("negated", { domain: "negated.example.test" });
const audience = await business("audience", { domain: "audience.example.test" });
const labelConflict = await business("labelconflict", { domain: "label-conflict.example.test", vertical: "Dentist" });
const labelAgree = await business("labelagree", { domain: "label-agree.example.test", vertical: "Dentist" });
aiQuote(cta, "Healthcare", "book an appointment");
aiQuote(negated, "Healthcare", "dental services");
aiQuote(audience, "Healthcare", "dental practices");
await classify([cta, negated, audience, labelConflict, labelAgree]);
for (const [id, code, label] of [
  [cta, "AI_CITATION_GENERIC", "a call to action"], [negated, "AI_CITATION_NEGATED", "a denied service"],
  [audience, "AI_CITATION_AUDIENCE_NOT_ACTIVITY", "a served industry"],
] as const) {
  const r = await latest(id);
  check(r.outcome === "target" && r.admission_tier === null && JSON.stringify(r.reason_codes).includes(code) &&
    (await effective(id)).v === null, `The AI's Healthcare proposal quoting ${label} is retained but not accepted (${code})`);
}
row = await latest(labelConflict);
check(row.outcome === "review_required" && row.admission_tier === null && row.resolved_vertical_id === null &&
  JSON.stringify(row.reason_codes).includes("ACCEPTANCE_CONFLICT:label_vs_policy:Healthcare|Automotive") &&
  (await effective(labelConflict)).v === null,
  "An existing label that resolves is checked against reliable page evidence: a different vertical records the conflict");
row = await latest(labelAgree);
check(row.outcome === "target" && ["resolved_high", "resolved_medium"].includes(row.admission_tier) && row.resolved_vertical_id === "Healthcare",
  "An existing label that agrees with the page keeps its tier");

// Retained, identity-matched Serper category is the listing source; labels and unmatched rows are not.
const catAccepted = await business("cataccepted");
const catEvidenceId = await retain(catAccepted, "Dentist");
const catDiscredited = await business("catdiscredited");
await pool.query("INSERT INTO sfp_discredited_paid_evidence (evidence_id,business_id,reason_code) VALUES($1,$2,'certification')",
  [await retain(catDiscredited, "Dentist"), catDiscredited]);
const catUnmatched = await business("catunmatched");
await retain(catUnmatched, "Dentist", false);
const catQuarantined = await business("catquarantined");
await retain(catQuarantined, "Dentist");
{
  const client = await pool.connect();
  try {
    await client.query("SET session_replication_role=replica");
    const cohort = (await client.query("SELECT id FROM sfp_cohort_runs LIMIT 1")).rows[0]?.id ?? randomUUID();
    await client.query(`INSERT INTO sfp_identity_quarantines (business_id,reason_code,suspect_domain,source_cohort_run_id)
      VALUES($1,'certification','example.test',$2)`, [catQuarantined, cohort]);
  } finally { await client.query("SET session_replication_role=DEFAULT"); client.release(); }
}
const labelOnly = await business("labelonly", { industry: "Dentist", vertical: "Healthcare Services" });
await classify([catAccepted, catDiscredited, catUnmatched, catQuarantined, labelOnly]);
row = await latest(catAccepted);
check(row.admission_tier === "policy_accepted" && row.acceptance_basis === "listing_category" && row.resolved_vertical_id === "Healthcare" &&
  row.acceptance_facts.facts[0].sourceRef.evidenceId === catEvidenceId && row.acceptance_facts.facts[0].sourceRef.provider === "serper" &&
  row.acceptance_facts.facts[0].sourceRef.endpoint === "maps", "A retained identity-matched listing category is accepted with its evidence provenance");
for (const [id, label] of [[catDiscredited, "discredited"], [catUnmatched, "not identity-matched"], [catQuarantined, "quarantined"], [labelOnly, "an imported industry label"]] as const) {
  const all = await allRows(id);
  check(all.length > 0 && all.every((r) => r.admission_tier === null) && (await effective(id)).v === null,
    `A category from ${label} evidence is not accepted`);
}
const retainedRead = await loadRetainedListingCategories(catAccepted);
check((await pool.query(`SELECT ${sfpInputFingerprintSql("b")} AS fp FROM businesses b WHERE b.id=$1`, [catAccepted])).rows[0].fp ===
  sfpInputFingerprint({ listingCategoryHashes: retainedRead.hashes }) && retainedRead.categories[0].text === "Dentist",
  "The fingerprint includes retained listing categories, byte-identical in TypeScript and SQL");

// Old untiered target results are reconsidered by the bridge itself, then by the ordinary continuation.
async function legacyUntiered(label: string, domain: string, page: Page) {
  pages.set(domain, page);
  const id = await business(label, { domain });
  await pool.query(`INSERT INTO sfp_classification_evidence
    (business_id,evidence_hash,source_refs,classifier_version,taxonomy_version,policy_version,model_version,outcome,reason_codes,idempotency_key,terminal_state)
    VALUES($1,$2,'[]'::jsonb,$3,2,$4,'legacy-test','target','[]'::jsonb,$5,'completed')`,
    [id, `${prefix}${label}hash`, CLASSIFIER_VERSION, policyVersion, `${prefix}:legacy:${label}`]);
  return id;
}
const legacyBridge = await legacyUntiered("legacybridge", "legacy-bridge.example.test", { title: "Smile", headings: ["Cosmetic dentistry"] });
check((await effective(legacyBridge)).v === null, "An untiered pre-policy target does not read as an accepted vertical");
await classify([legacyBridge]);
row = await latest(legacyBridge);
check(row.admission_tier === "policy_accepted" && row.resolved_vertical_id === "Healthcare" && row.input_fingerprint,
  "An old untiered target is reconsidered under the policy and accepted from one clear source");

// Ordinary continuation: rename so the automatic program resolves to this certification program.
await pool.query("UPDATE sfp_programs SET name=name||'-retired-'||substr(id::text,1,8),is_active=FALSE WHERE name='south-florida-v1'");
await pool.query("UPDATE sfp_programs SET name='south-florida-v1' WHERE id=$1", [programId]);
const legacyTick = await legacyUntiered("legacytick", "legacy-tick.example.test", { title: "Smile", headings: ["Orthodontics and braces"] });
const unreadSite = await business("unreadsite", { domain: "unread-site.example.test" });
pages.set("unread-site.example.test", { title: "Quick Lube", headings: ["Brake repair and oil change"] });
await runPreCohortClassificationBridge({
  programId, idempotencyKey: `${prefix}:freeonly:unread`, actorId: actor.actorId, maxBusinesses: 10, targetIds,
  policyVersion, taxonomyVersion: 2, businessIdFilter: [unreadSite], freeOnly: true,
}, {} as any);
row = await latest(unreadSite);
check(!row && (await allRows(unreadSite))[0].terminal_state === "provisional" &&
  JSON.stringify((await allRows(unreadSite))[0].reason_codes).includes("FREE_ONLY_WEBSITE_EVIDENCE_NOT_FETCHED"),
  "A free window that does not read websites leaves a provisional non-attempt");
const catChange = await business("catchange", { primary: "Auto repair shop" });
await classify([catChange]);
const catChangeFirst = (await pool.query(`SELECT id FROM sfp_paid_candidate_evidence WHERE business_id=$1`, [catChange])).rows[0].id;
await pool.query("INSERT INTO sfp_discredited_paid_evidence (evidence_id,business_id,reason_code) VALUES($1,$2,'certification')", [catChangeFirst, catChange]);
await retain(catChange, "Hair salon");
check((await effective(catChange)).v === null, "A newly retained category makes the earlier decision stale at once");
// Website-based acceptances: unchanged, changed-but-still-supported, changed-and-no-longer-supported.
pages.set("site-same.example.test", { title: "Smile", headings: ["Family dentistry"] });
pages.set("site-changed.example.test", { title: "Smile", headings: ["Family dentistry"] });
pages.set("site-gone.example.test", { title: "Smile", headings: ["Family dentistry"] });
const siteSame = await business("sitesame", { domain: "site-same.example.test" });
const siteChanged = await business("sitechanged", { domain: "site-changed.example.test" });
const siteGone = await business("sitegone", { domain: "site-gone.example.test" });
await classify([siteSame, siteChanged, siteGone]);
pages.set("site-changed.example.test", { title: "Luxe", headings: ["Hair stylist and day spa"] });
pages.set("site-gone.example.test", { title: "Coming soon", headings: ["Under construction"] });
const siteSameRows = (await allRows(siteSame)).length;
const recent = (await pool.query("SELECT count(*)::int n FROM sfp_classification_items i JOIN sfp_classification_evidence e ON e.id=i.evidence_id WHERE e.business_id=ANY($1::int[]) AND i.completed_at>NOW()-INTERVAL '1 day'",
  [[siteSame, siteChanged, siteGone]])).rows[0].n;
check(recent === 3 && (await effective(siteChanged)).v === "Healthcare", "Before the recheck interval the old acceptance stands even though the site changed");
await pool.query("UPDATE sfp_classification_items SET completed_at=NOW()-INTERVAL '40 days' WHERE business_id=ANY($1::int[])", [[siteSame, siteChanged, siteGone]]);

const extractWebsiteEvidence = async (url: string) => {
  const domain = new URL(url).hostname;
  const page = pages.get(domain);
  if (!page) return { error: "fetch_failed" };
  if ("error" in page) return page;
  return pageEvidence(domain, page);
};
const blockedBefore = getBlockedCertificationNetworkAttemptCount();
const tick = await processSfpFreeClassificationTick(undefined, { bridgeDeps: { extractWebsiteEvidence } as any });
check(tick.claimed === true && (tick.processed ?? 0) >= 5, "The ordinary continuation tick reconsiders due businesses without any manual step");
row = await latest(legacyTick);
check(row.admission_tier === "policy_accepted" && row.resolved_vertical_id === "Healthcare", "The continuation reconsiders an untiered target and accepts it from its website");
row = await latest(unreadSite);
check(row.admission_tier === "policy_accepted" && row.resolved_vertical_id === "Automotive", "The continuation reads the website of a provisional free-window result and accepts it");
row = await latest(catChange);
check(row.admission_tier === "policy_accepted" && row.resolved_vertical_id === "Beauty/Spa" && (await effective(catChange)).v === "Beauty/Spa",
  "The continuation re-evaluates a business whose retained listing category changed");
check((await allRows(siteSame)).length === siteSameRows && (await effective(siteSame)).v === "Healthcare" &&
  Number((await pool.query("SELECT count(*)::int n FROM sfp_classification_items WHERE business_id=$1 AND completed_at>NOW()-INTERVAL '1 day'", [siteSame])).rows[0].n) >= 1,
  "A scheduled website recheck with unchanged content reuses the decision and records that the site was read");
row = await latest(siteChanged);
check(row.resolved_vertical_id === "Beauty/Spa" && row.admission_tier === "policy_accepted" && (await effective(siteChanged)).v === "Beauty/Spa",
  "Changed site content on the same domain is re-evaluated and the new vertical is accepted");
row = await latest(siteGone);
check(row.outcome === "review_required" && JSON.stringify(row.reason_codes).includes("PRIOR_WEBSITE_ACCEPTANCE_SUPERSEDED") &&
  (await effective(siteGone)).v === null,
  "Changed site content that no longer supports the vertical supersedes the old acceptance");
const tickRows = Number((await pool.query("SELECT count(*)::int n FROM sfp_classification_evidence")).rows[0].n);
await processSfpFreeClassificationTick(undefined, { bridgeDeps: { extractWebsiteEvidence } as any });
check(Number((await pool.query("SELECT count(*)::int n FROM sfp_classification_evidence")).rows[0].n) <= tickRows + 3,
  "A second tick does not repeat the reconsideration (no per-tick evidence growth)");
check(getBlockedCertificationNetworkAttemptCount() === blockedBefore, "Reconsideration made no provider or network attempt");

// Immutability and the schema contract.
await assert.rejects(pool.query("UPDATE sfp_classification_evidence SET admission_tier=NULL WHERE business_id=$1", [webOnly]), /immutable|cannot|not allowed|insert-only/i);
checks++;
await assert.rejects(pool.query(`INSERT INTO sfp_classification_evidence
  (business_id,evidence_hash,source_refs,classifier_version,taxonomy_version,policy_version,outcome,reason_codes,idempotency_key,terminal_state,resolved_vertical_id,admission_tier)
  VALUES($1,'x','[]'::jsonb,3,2,$2,'target','[]'::jsonb,$3,'completed','Healthcare','policy_accepted')`,
  [nameOnly, policyVersion, `${prefix}:bad-tier`]), /policy_acceptance_chk/);
checks++;

// Handoff: accepted businesses reach paused preparation through the existing owners.
async function linkedContact(businessId: number) {
  const label = randomUUID().replaceAll("-", "");
  const biz = (await pool.query("SELECT * FROM businesses WHERE id=$1", [businessId])).rows[0];
  const contact = (await pool.query(`INSERT INTO contacts (first_name,last_name,email,phone,company_name,record_class)
    VALUES('Canonical','Fixture',$1,'',$2,'production') RETURNING id`,
    [`${prefix.slice(0, 30)}.${label.slice(0, 24)}@gmail.com`, `${biz.canonical_name} LLC`])).rows[0];
  await pool.query(`INSERT INTO contact_source_events (contact_id,event_key,source_category,source_type,source_external_id,actor_type,actor_id,metadata)
    VALUES($1,$2,'import','google_maps_outscraper',$2,'system',$3,$4::jsonb)`,
    [contact.id, `${prefix}_${label}_event`, actor.actorId, JSON.stringify({ place_id: biz.google_place_id })]);
  const preview = await previewContactBusinessSystemLinks({ afterContactId: Number(contact.id) - 1, limit: 1 });
  const candidate = preview.rows[0];
  check(candidate?.eligible, "Independent stable evidence supports the business affiliation");
  const outcome = await applyContactBusinessSystemLink({
    contactId: Number(contact.id), businessId, sourceLinkId: candidate.sourceLinkId!, sourceEntityId: candidate.sourceEntityId,
    snapshotHash: candidate.snapshotHash,
  });
  check(outcome.status === "applied", "The real reviewed relationship writer applies the link");
  return Number(contact.id);
}
for (const [label, id] of [["website-only", webOnly], ["listing-only", listingOnly]] as const) {
  const contactId = await linkedContact(id);
  const prepared = await prepareCanonicalRecipient({ contactId, sequenceId, programId, actor, source: prefix });
  check(prepared.preparationState === "pending_validation" && prepared.enrollmentId != null,
    `The ${label} accepted business reaches prepared (pending validation) with no manual approval`);
  const member = (await pool.query("SELECT status,next_action_at,metadata FROM sequence_enrollments WHERE id=$1", [prepared.enrollmentId])).rows[0];
  check(member.status === "paused" && member.next_action_at == null && member.metadata.outboundAuthorized === false,
    `The ${label} preparation is paused with no send authority`);
}
const unaccepted = await linkedContact(nameOnly);
const notPrepared = await prepareCanonicalRecipient({ contactId: unaccepted, sequenceId, programId, actor, source: prefix });
check(notPrepared.enrollmentId == null, "A business whose vertical was never accepted is not prepared");

const opsAfter = Number((await pool.query("SELECT count(*)::int n FROM provider_operations")).rows[0].n);
check(opsAfter === opsBefore, "No provider operation was recorded");
check(getBlockedCertificationNetworkAttemptCount() === 0, "No attempted provider or network transport");
console.log(`PASS: ${checks} vertical acceptance policy checks; fake transports only, no provider calls`);
await pool.end();
