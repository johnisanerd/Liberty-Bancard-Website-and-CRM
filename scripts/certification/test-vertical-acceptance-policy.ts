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
const noListing = { structuredVertical: null, industryPrimary: null, industrySecondary: null };
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
    website: null, listing: { structuredVertical: null, industryPrimary: "Dentist", industrySecondary: null }, targetIds });
  check(listing.kind === "accepted" && listing.basis === "listing_category" && listing.verticalId === "Healthcare",
    "An identity-matched listing category that maps to one vertical is accepted with no AI call");
  const vs = accept.decideDeterministicAcceptance({
    website: dental, listing: { structuredVertical: null, industryPrimary: "Plumbing", industrySecondary: null }, targetIds });
  check(vs.kind === "conflict" && vs.reasonCodes[0].startsWith("ACCEPTANCE_CONFLICT:website_vs_listing:"),
    "Website and listing disagreement is a recorded conflict");
  const both = accept.decideDeterministicAcceptance({
    website: dental, listing: { structuredVertical: null, industryPrimary: "Dentist", industrySecondary: null }, targetIds });
  check(both.kind === "accepted" && both.basis === "website_and_listing" &&
    both.facts.facts.some((f) => f.source === "website") && both.facts.facts.some((f) => f.source === "listing_category"),
    "Agreement accepts and retains both sources");
  const nameOnly = accept.decideDeterministicAcceptance({
    website: null, listing: { structuredVertical: null, industryPrimary: "Services", industrySecondary: null }, targetIds });
  check(nameOnly.kind === "none", "An unsupported or generic label is retained as a suggestion, never accepted");
  const ai = accept.decideAiAcceptance({ verticalId: "Healthcare", citation: { source: "website", quote: "Family   DENTISTRY" },
    website: dental, listing: noListing });
  check(ai.decision.kind === "accepted" && ai.decision.basis === "ai_cited", "An AI proposal with a verifiable quote is accepted by the policy");
  check(accept.decideAiAcceptance({ verticalId: "Healthcare", citation: { source: "website", quote: "Dental implants" },
    website: dental, listing: noListing }).failure === "AI_CITATION_NOT_IN_WEBSITE_EVIDENCE",
    "A quote that is not in the retained evidence is rejected");
  check(accept.decideAiAcceptance({ verticalId: "Healthcare", citation: { source: "website", quote: "health" },
    website: healthWord, listing: noListing }).failure === "AI_CITATION_GENERIC", "A generic quote is rejected");
  check(accept.decideAiAcceptance({ verticalId: "Healthcare", citation: { source: null, quote: null },
    website: dental, listing: noListing }).failure === "AI_CITATION_MISSING", "A bare AI target without a citation is rejected");
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
    `SELECT ${sfpInputFingerprintSql("b")} AS fp FROM (SELECT $1::text AS vertical,$2::text AS industry_primary,$3::text AS industry_secondary) b`,
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

async function business(label: string, o: { domain?: string; primary?: string; name?: string } = {}) {
  const place = `${prefix}_${label}_place`;
  const row = (await pool.query(`INSERT INTO businesses
    (canonical_name,normalized_name,record_class,google_place_id,vertical,industry_primary,website_domain,city,state,postal_code)
    VALUES($1,$2,'canonical',$3,NULL,$4,$5,'Miami','FL','33130') RETURNING id`,
    [o.name ?? `${prefix} ${label}`, `${prefix}${label}`, place, o.primary ?? null, o.domain ?? null])).rows[0];
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
await pool.query("UPDATE businesses SET industry_primary='Hair Salon' WHERE id=$1", [listingOnly]);
check((await effective(listingOnly)).v === null, "A changed listing category immediately supersedes the old acceptance");
await classify([listingOnly]);
row = await latest(listingOnly);
check(row.resolved_vertical_id === "Beauty/Spa" && row.acceptance_basis === "listing_category", "Changed evidence is reconsidered automatically and re-accepted");
check((await effective(listingOnly)).v === "Beauty/Spa", "The reader follows the newest accepted decision");
await pool.query("UPDATE businesses SET industry_primary='Auto Repair' WHERE id=$1", [listingOnly]);
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
