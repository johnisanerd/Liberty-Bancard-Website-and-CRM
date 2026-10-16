import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { applyCertificationProviderDenyBoundary,
  getBlockedCertificationNetworkAttemptCount } from "../certification-provider-deny";
await assertDisposableTestInfrastructure({ operation: "staged-email materialization certification" });
process.env.VG_PROVIDER_DENY_MODE = "1";
applyCertificationProviderDenyBoundary({ fatal: true });
const { pool } = await import("../../server/db");
const { seal } = await import("../../server/services/cro03/candidate-evidence-service");
const { runStagedEmailMaterialization, attributeStagedAddress } =
  await import("../../server/services/free-discovery/staged-email-materialization");

const prefix = `cert_staged_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const actorId = `system:${prefix}`;
let checks = 0;
const check = (value: unknown, message: string) => { assert(value, message); checks++; };
const q = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows;
const one = async (text: string, params: unknown[] = []) => (await q(text, params))[0];

const generationId = (await one(`INSERT INTO free_discovery_generations(run_key,actor_id,reason)
  VALUES($1,$2,'staged-email materialization certification') RETURNING id`, [prefix, actorId])).id;

let seq = 0;
const tag = () => `${prefix}${++seq}`.replace(/_/g, "");
async function business(opts: { domain?: string | null; vertical?: string | null; name?: string } = {}) {
  const label = tag();
  const place = `${prefix}_${label}_place`;
  const domain = opts.domain === undefined ? `${label}.net` : opts.domain;
  const b = await one(`INSERT INTO businesses
    (canonical_name,normalized_name,record_class,google_place_id,vertical,city,state,postal_code,website_domain)
    VALUES($1,$2,'canonical',$3,$4,'Miami','FL','33130',$5) RETURNING *`,
    [opts.name ?? `Cert Shop ${label}`, `certshop${label}`, place,
      opts.vertical === undefined ? "Automotive" : opts.vertical, domain]);
  await q(`INSERT INTO canonical_source_links(business_id,source_system,source_type,stable_key)
    VALUES($1,'google_maps','place',$2)`, [b.id, place]);
  return { id: Number(b.id), name: String(b.canonical_name), domain: domain as string | null };
}
async function stage(businessId: number, email: string, opts: {
  scope?: "role" | "named"; source?: string; domain?: string; person?: string; title?: string; generation?: string;
} = {}) {
  const sealed = seal("email", email);
  const domain = "domain" in opts ? opts.domain : (email.split("@")[1] ?? "unknown.net");
  const r = await one(`INSERT INTO free_discovery_candidates
    (generation_id,field,subject_type,business_id,domain,source,attribution_scope,person_name_evidence,
     person_title_evidence,disposition,confidence,envelope_ciphertext,envelope_nonce,envelope_tag,
     envelope_key_version,normalized_value_hash,masked_value)
    VALUES($1,'email','business',$2,$3,$4,$5,$6,$7,'staged',80,$8,$9,$10,1,$11,$12) RETURNING id`,
    [opts.generation ?? generationId, businessId, domain, opts.source ?? "first_party_contact_page", opts.scope ?? "role",
      opts.person ?? null, opts.title ?? null, sealed.ciphertext, sealed.nonce, sealed.tag,
      sealed.normalizedValueHash, sealed.maskedValue]);
  return String(r.id);
}
const run = (limit = 500, extra: object = {}) => runStagedEmailMaterialization({ limit, actorId, ...extra });
const contactByEmail = (email: string) =>
  one(`SELECT * FROM contacts WHERE lower(email)=lower($1) AND archived_at IS NULL`, [email]);
const decisions = (contactId: number) =>
  q(`SELECT * FROM contact_business_link_decisions WHERE contact_id=$1`, [contactId]);
const outcome = (candidateId: string) =>
  one(`SELECT * FROM free_discovery_materialization_outcomes WHERE candidate_id=$1`, [candidateId]);

try {
  const before = await one(`SELECT
    (SELECT count(*) FROM provider_operations)::int operations,
    (SELECT count(*) FROM communication_events)::int communications,
    (SELECT count(*) FROM sfp_cohort_runs)::int cohorts`);

  // ── Pure attribution rules ────────────────────────────────────────────────
  check(!attributeStagedAddress("http://info@lhm.com", "lhm.com", "lhm.com").ok, "URL-prefixed address is not clean");
  check((attributeStagedAddress("john.s@email.com", "x.com", "x.com") as any).reason === "PLACEHOLDER_ADDRESS", "Placeholder domain rejected");
  check((attributeStagedAddress("ola@nordmann.no", "lhm.com", "lhm.com") as any).reason === "THIRD_PARTY_DOMAIN", "Third-party domain rejected");
  check((attributeStagedAddress("a@mail.shop.com", "www.shop.com", "shop.com") as any).basis === "business_domain", "Subdomain of the business site is its own domain");
  const siteRejected = (r: any) => !r.ok && r.reason === "CRAWL_SITE_NOT_BUSINESS_SITE";
  check(siteRejected(attributeStagedAddress("info@other.net", "other.net", "shop.com")),
    "An unrelated candidate/crawl domain never attributes a business-domain address");
  check(siteRejected(attributeStagedAddress("x@gmail.com", "other.net", "shop.com")),
    "A mailbox-provider address with an unrelated crawl domain is not attributed");
  check(siteRejected(attributeStagedAddress("x@gmail.com", "", "shop.com"))
    && siteRejected(attributeStagedAddress("x@gmail.com", null, "shop.com"))
    && siteRejected(attributeStagedAddress("x@gmail.com", "shop.com", null)),
    "A mailbox-provider address with an empty crawl or business domain is not attributed");
  check(siteRejected(attributeStagedAddress("x@gmail.com", "gmail.com", "gmail.com")),
    "A freemail 'site domain' never counts as business-owned");
  check((attributeStagedAddress("x@gmail.com", "www.shop.com", "shop.com") as any).basis === "provider_mailbox",
    "Gmail stays supported when published on the business's own crawled site");

  // ── Staged role mailbox -> contact -> verified link, no new business ──────
  const businessesBefore = Number((await one(`SELECT count(*) n FROM businesses`)).n);
  const shop = await business();
  const role = `info@${shop.domain}`;
  const roleCandidate = await stage(shop.id, role);
  const businessesAfterFixture = Number((await one(`SELECT count(*) n FROM businesses`)).n);
  const first = await run();
  check(first.created >= 1, "Run creates contacts from staged evidence");
  const roleContact = await contactByEmail(role);
  check(roleContact && Number(roleContact.business_id) === shop.id, "Contact is projected onto the candidate's exact business");
  const roleDecisions = await decisions(Number(roleContact.id));
  check(roleDecisions.length === 1 && roleDecisions[0].decision === "verified"
    && roleDecisions[0].actor_id === "system" && roleDecisions[0].first_party_evidence_id
    && !roleDecisions[0].system_evidence_id && !roleDecisions[0].sfp_evidence_id,
    "Exactly one verified decision through the first-party evidence kind (no impersonated source type)");
  const evidence = await one(`SELECT * FROM contact_business_first_party_link_evidence WHERE id=$1`,
    [roleDecisions[0].first_party_evidence_id]);
  check(evidence.candidate_id === roleCandidate && evidence.domain_basis === "business_domain"
    && evidence.attribution_scope === "role" && evidence.address_domain === shop.domain
    && evidence.crawl_domain === shop.domain && evidence.business_site_domain === shop.domain
    && evidence.site_relation === "business_website_domain",
    "Evidence pins candidate, business-domain basis, role scope and the retained business-to-site relationship");
  check(roleContact.record_class === "production", "Verified first-party contact receives its initial production class");
  check(Number((await one(`SELECT count(*) n FROM businesses`)).n) === businessesAfterFixture
    && businessesAfterFixture === businessesBefore + 1, "No business was created or re-matched");
  check(roleContact.last_name === "Contact" && roleContact.first_name === shop.name,
    "Role mailbox is not given an invented person name");
  const event = await one(`SELECT source_category,source_type,metadata FROM contact_source_events WHERE contact_id=$1`, [roleContact.id]);
  check(event.source_category === "discovery" && event.source_type === "free_discovery"
    && event.metadata.contactNameBasis === "business_name_placeholder"
    && event.metadata.candidateId === roleCandidate && event.metadata.businessId === shop.id,
    "Provenance is accurate (free_discovery, not provider/cro03) and names the candidate and business");
  check((await outcome(roleCandidate))?.outcome === "linked", "Durable per-candidate outcome recorded");
  check((await one(`SELECT disposition,promoted_at FROM free_discovery_candidates WHERE id=$1`, [roleCandidate]))
    .disposition === "staged", "Candidate evidence row is not mutated");
  check(roleContact.email_status == null || ["unvalidated", "active"].includes(roleContact.email_status),
    "Association did not depend on or change validation state");

  // ── Replay ─────────────────────────────────────────────────────────────────
  const replay = await run();
  check(replay.created === 0 && (await decisions(Number(roleContact.id))).length === 1,
    "Replay does not duplicate contact or decision");
  await q(`DELETE FROM free_discovery_materialization_outcomes WHERE candidate_id=$1`, [roleCandidate]);
  const lostOutcome = await run();
  check(lostOutcome.alreadyLinked === 1 && lostOutcome.created === 0
    && Number((await one(`SELECT count(*) n FROM contacts WHERE lower(email)=lower($1)`, [role])).n) === 1
    && (await decisions(Number(roleContact.id))).length === 1,
    "Lost outcome row: rerun converges to already_linked without a second contact/decision");

  // ── Named evidence is person-subject by DB contract: no business identity to attach ──
  const named = await business();
  await assert.rejects(stage(named.id, `maria.lopez@${named.domain}`, { scope: "named", person: "Maria Lopez" }),
    /free_discovery_candidates_subject_type_consistency_chk/);
  checks++;

  // ── Provider mailbox published on the business's own page; unmapped vertical ─
  const unmapped = await business({ vertical: null });
  const gmail = `${tag()}.owner@gmail.com`;
  const gmailCandidate = await stage(unmapped.id, gmail, { source: "contact_page", domain: unmapped.domain! });
  const gmailRun = await run();
  const gmailContact = await contactByEmail(gmail);
  check(gmailContact && Number(gmailContact.business_id) === unmapped.id
    && (await one(`SELECT domain_basis FROM contact_business_first_party_link_evidence WHERE contact_id=$1`,
      [gmailContact.id])).domain_basis === "provider_mailbox",
    "Mailbox-provider address on the business's own page links; vertical mapping is not a link condition");

  // ── Existing unlinked contact is reused (no duplicate, no global uniqueness) ─
  const reuse = await business();
  const reuseEmail = `Sales@${reuse.domain}`;
  const existing = await one(`INSERT INTO contacts(first_name,last_name,email,phone,company_name,record_class)
    VALUES('Pat','Existing',$1,'','Some Other Co','unknown') RETURNING id`, [reuseEmail]);
  await stage(reuse.id, reuseEmail.toLowerCase());
  const reuseRun = await run();
  const reused = await one(`SELECT * FROM contacts WHERE id=$1`, [existing.id]);
  check(reuseRun.linkedExisting >= 1 && Number(reused.business_id) === reuse.id && reused.record_class === "production"
    && reused.first_name === "Pat" && Number((await one(`SELECT count(*) n FROM contacts WHERE lower(email)=lower($1)`, [reuseEmail])).n) === 1,
    "Existing unlinked contact is reused and linked; its own identity is preserved");

  // ── Contradictions are held, not linked ────────────────────────────────────
  const elsewhereBiz = await business();
  const otherBiz = await business();
  const elsewhereEmail = `info@${elsewhereBiz.domain}`;
  const linkedElsewhere = await one(`INSERT INTO contacts(first_name,last_name,email,phone,company_name,record_class)
    VALUES('El','Se',$1,'','X','production') RETURNING id`, [elsewhereEmail]);
  await q(`UPDATE contacts SET business_id=$1 WHERE id=$2`, [otherBiz.id, linkedElsewhere.id]);
  const elsewhereCandidate = await stage(elsewhereBiz.id, elsewhereEmail);

  const thirdParty = await business();
  const thirdPartyCandidate = await stage(thirdParty.id, `ola@${tag()}.no`, { domain: thirdParty.domain! });
  const unrelatedSite = await business();
  const unrelatedDomain = `${tag()}.org`;
  const unrelatedCandidate = await stage(unrelatedSite.id, `info@${unrelatedDomain}`, { domain: unrelatedDomain });
  const unrelatedGmailSite = await business();
  const unrelatedGmailCandidate = await stage(unrelatedGmailSite.id, `${tag()}.owner@gmail.com`, { domain: unrelatedDomain });
  const emptySite = await business();
  const emptyGmailCandidate = await stage(emptySite.id, `${tag()}.owner@gmail.com`, { domain: "" });
  const dirty = await business();
  const dirtyCandidate = await stage(dirty.id, `http://info@${dirty.domain}`);
  const placeholder = await business();
  const placeholderCandidate = await stage(placeholder.id, "john.s@email.com", { domain: placeholder.domain! });

  const sharedDomain = `${tag()}.net`;
  const sharedA = await business({ domain: sharedDomain });
  const sharedB = await business({ domain: sharedDomain });
  const sharedACandidate = await stage(sharedA.id, `info@${sharedDomain}`);

  const rivalEmail = `rival@${tag()}.net`;
  const rivalA = await business({ domain: null });
  const rivalB = await business({ domain: null });
  await stage(rivalA.id, rivalEmail, { domain: rivalEmail.split("@")[1] });
  const secondGeneration = (await one(`INSERT INTO free_discovery_generations(run_key,actor_id,reason)
    VALUES($1,$2,'rival evidence generation') RETURNING id`, [`${prefix}_rival`, actorId])).id;
  await stage(rivalB.id, rivalEmail, { domain: rivalEmail.split("@")[1], generation: secondGeneration });

  const contradictions = await run();
  const held = async (id: string, code: string) => {
    const o = await outcome(id);
    return o?.outcome === "held" && o.reason_code === code;
  };
  check(await held(elsewhereCandidate, "EXISTING_CONTACT_LINKED_ELSEWHERE")
    && Number((await one(`SELECT business_id FROM contacts WHERE id=$1`, [linkedElsewhere.id])).business_id) === otherBiz.id,
    "Contact already tied to another business is held and untouched");
  check(await held(thirdPartyCandidate, "THIRD_PARTY_DOMAIN"), "Third-party domain held");
  check(await held(unrelatedCandidate, "CRAWL_SITE_NOT_BUSINESS_SITE") && await held(unrelatedGmailCandidate, "CRAWL_SITE_NOT_BUSINESS_SITE")
    && await held(emptyGmailCandidate, "CRAWL_SITE_NOT_BUSINESS_SITE"),
    "Unrelated candidate domain, and mailbox-provider addresses with an unrelated or empty crawl domain, are held; no contact guessed");
  check(await held(dirtyCandidate, "EMAIL_NOT_CLEAN"), "Dirty address held");
  check(await held(placeholderCandidate, "PLACEHOLDER_ADDRESS"), "Placeholder address held");
  check(await held(sharedACandidate, "SHARED_LOCATION_DOMAIN")
    && !(await contactByEmail(`info@${sharedDomain}`)), "Shared-location domain held; no contact guessed");
  check(!(await contactByEmail(rivalEmail)) && Object.keys(contradictions.held).length >= 5,
    "Same address staged for two businesses is neither linked nor guessed");
  const heldRerun = await run();
  check(heldRerun.examined === 0 || Object.values(heldRerun.held).reduce((a, b) => a + b, 0) === 0,
    "Fresh holds are not re-evaluated every run");

  // ── Invalid existing contacts do not block useful recipients; cap counts usable only ─
  const capBiz = await business();
  for (const status of ["invalid", "invalid", "bounced"]) {
    const c = await one(`INSERT INTO contacts(first_name,last_name,email,phone,company_name,record_class,email_status)
      VALUES('Bad','Mail',$1,'','Bad Co','production',$2) RETURNING id`, [`${tag()}@${capBiz.domain}`, status]);
    await q(`UPDATE contacts SET business_id=$1 WHERE id=$2`, [capBiz.id, c.id]);
  }
  const useful = [`info@${capBiz.domain}`, `sales@${capBiz.domain}`, `office@${capBiz.domain}`, `extra@${capBiz.domain}`];
  for (const email of useful) await stage(capBiz.id, email);
  await run();
  const linkedUseful = await q(`SELECT email FROM contacts WHERE business_id=$1 AND email_status IS DISTINCT FROM 'invalid'
    AND email_status IS DISTINCT FROM 'bounced'`, [capBiz.id]);
  check(linkedUseful.length === 3, "Three invalid/bounced contacts do not consume the batch allowance; three useful recipients link, the fourth waits");

  // ── Concurrent runs ────────────────────────────────────────────────────────
  const concurrent = await business();
  const concurrentEmail = `info@${concurrent.domain}`;
  await stage(concurrent.id, concurrentEmail);
  const results = await Promise.all([run(), run(), run()]);
  check(results.reduce((n, r) => n + r.created, 0) === 1
    && Number((await one(`SELECT count(*) n FROM contacts WHERE lower(email)=lower($1)`, [concurrentEmail])).n) === 1
    && (await decisions(Number((await contactByEmail(concurrentEmail)).id))).length === 1,
    "Concurrent runs create one contact and one decision");

  // ── Native guard rejects forged / out-of-contract first-party decisions ───
  // Every case is built from REAL candidate/contact/business rows; only the binding under test differs, and a
  // positive control built by the same helper must pass, so rejections cannot come from a malformed fixture.
  const FENCE = /COMMERCIAL_FIRST_PARTY_LINK_AUTHORITY_FENCE_LOST/;
  const norm = (d: string | null | undefined) => String(d ?? "").trim().toLowerCase().replace(/^www\./, "");
  async function forge(opts: {
    candidateEmail: string; contactEmail: string; basis?: "business_domain" | "provider_mailbox";
    businessDomain?: string | null; candidateDomain?: string | null;
    crawlDomain?: string | null; siteDomain?: string | null; siteRelation?: string | null; key?: string;
  }) {
    const biz = await business({ domain: opts.businessDomain === undefined ? undefined : opts.businessDomain });
    const candDomain = "candidateDomain" in opts ? opts.candidateDomain : biz.domain;
    const cand = await stage(biz.id, opts.candidateEmail, { domain: candDomain });
    const contact = await one(`INSERT INTO contacts(first_name,last_name,email,phone,company_name,record_class,email_token_hash)
      VALUES('F','Orge',$1,'','F Co','production',encode(sha256(convert_to(lower(trim($1::text)),'UTF8')),'hex')) RETURNING *`,
      [opts.contactEmail]);
    const key = opts.key ?? `${prefix}:forge:${tag()}`;
    const evidenceRow = await one(`INSERT INTO contact_business_first_party_link_evidence
      (decision_key,contact_id,business_id,candidate_id,candidate_hash,contact_email_token_hash,address_domain,
       domain_basis,attribution_scope,candidate_source,rule_version,facts_hash,facts,crawl_domain,business_site_domain,site_relation)
      SELECT $1,$2,$3,fc.id,fc.normalized_value_hash,$4,$5,$6,fc.attribution_scope,fc.source,'forged','x','{}'::jsonb,$8,$9,$10
        FROM free_discovery_candidates fc WHERE fc.id=$7 RETURNING id`,
      [key, contact.id, biz.id, contact.email_token_hash, contact.email.split("@")[1].toLowerCase(),
        opts.basis ?? "business_domain", cand,
        "crawlDomain" in opts ? opts.crawlDomain : norm(candDomain),
        "siteDomain" in opts ? opts.siteDomain : norm(biz.domain),
        "siteRelation" in opts ? opts.siteRelation : "business_website_domain"]);
    const attempt = () => q(`INSERT INTO contact_business_link_decisions
      (contact_id,business_id,decision,decision_key,actor_id,revision,first_party_evidence_id)
      VALUES($1,$2,'verified',$3,'system',1,$4)`, [contact.id, biz.id, key, evidenceRow.id]);
    return { biz, contact, cand, attempt };
  }
  const controlTag = tag();
  const control = await forge({ candidateEmail: `info@${controlTag}.net`, contactEmail: `info@${controlTag}.net`, businessDomain: `${controlTag}.net` });
  await control.attempt();
  check((await decisions(Number(control.contact.id))).length === 1, "Positive control: a correctly bound first-party decision is accepted natively");
  const gmailControlTag = tag();
  const gmailControl = await forge({ candidateEmail: `${gmailControlTag}@gmail.com`, contactEmail: `${gmailControlTag}@gmail.com`,
    basis: "provider_mailbox" });
  await gmailControl.attempt();
  check((await decisions(Number(gmailControl.contact.id))).length === 1, "Positive control: Gmail published on the business's own site is accepted natively");

  const sameDomainTag = tag();
  const sameDomain = await forge({ candidateEmail: `info@${sameDomainTag}.net`, contactEmail: `sales@${sameDomainTag}.net`,
    businessDomain: `${sameDomainTag}.net` });
  await assert.rejects(sameDomain.attempt(), FENCE); checks++;
  const gmailTag = tag();
  const diffGmail = await forge({ candidateEmail: `${gmailTag}.a@gmail.com`, contactEmail: `${gmailTag}.b@gmail.com`, basis: "provider_mailbox" });
  await assert.rejects(diffGmail.attempt(), FENCE); checks++;
  const unrelTag = tag();
  const unrelBusinessDomain = await forge({ candidateEmail: `info@${unrelTag}.org`, contactEmail: `info@${unrelTag}.org`,
    candidateDomain: `${unrelTag}.org` });
  await assert.rejects(unrelBusinessDomain.attempt(), FENCE); checks++;
  const g1 = tag(); const g2 = tag();
  const gmailUnrelatedSite = await forge({ candidateEmail: `${g1}@gmail.com`, contactEmail: `${g1}@gmail.com`,
    basis: "provider_mailbox", candidateDomain: "unrelated-site.org" });
  await assert.rejects(gmailUnrelatedSite.attempt(), FENCE); checks++;
  const gmailLyingEvidence = await forge({ candidateEmail: `${g2}@gmail.com`, contactEmail: `${g2}@gmail.com`,
    basis: "provider_mailbox", candidateDomain: "unrelated-site.org", crawlDomain: "lying-claims-site.org" });
  await assert.rejects(gmailLyingEvidence.attempt(), FENCE); checks++;
  const g3 = tag();
  const gmailEmptyCrawl = await forge({ candidateEmail: `${g3}@gmail.com`, contactEmail: `${g3}@gmail.com`,
    basis: "provider_mailbox", candidateDomain: "", crawlDomain: null });
  await assert.rejects(gmailEmptyCrawl.attempt(), FENCE); checks++;
  const g4 = tag();
  const gmailEmptyString = await forge({ candidateEmail: `${g4}@gmail.com`, contactEmail: `${g4}@gmail.com`,
    basis: "provider_mailbox", candidateDomain: "", crawlDomain: "" });
  await assert.rejects(gmailEmptyString.attempt(), FENCE); checks++;
  const g5 = tag();
  const gmailNoRelation = await forge({ candidateEmail: `${g5}@gmail.com`, contactEmail: `${g5}@gmail.com`,
    basis: "provider_mailbox", siteRelation: null });
  await assert.rejects(gmailNoRelation.attempt(), FENCE); checks++;
  const g6 = tag();
  const siteMismatch = await forge({ candidateEmail: `${g6}@gmail.com`, contactEmail: `${g6}@gmail.com`,
    basis: "provider_mailbox", siteDomain: "different-business-site.org" });
  await assert.rejects(siteMismatch.attempt(), FENCE); checks++;

  // Native shared-domain and rival-hash fences (independent of the application checks).
  const sharedTag = tag();
  const sharedForged = await forge({ candidateEmail: `info@${sharedTag}.net`, contactEmail: `info@${sharedTag}.net`,
    businessDomain: `${sharedTag}.net` });
  await business({ domain: `${sharedTag}.net` });
  await assert.rejects(sharedForged.attempt(), FENCE); checks++;
  const rivalTag = tag();
  const rivalForged = await forge({ candidateEmail: `info@${rivalTag}.net`, contactEmail: `info@${rivalTag}.net`,
    businessDomain: `${rivalTag}.net` });
  const rivalOther = await business();
  await stage(rivalOther.id, `info@${rivalTag}.net`, { generation: (await one(`INSERT INTO free_discovery_generations(run_key,actor_id,reason)
    VALUES($1,$2,'forged rival generation') RETURNING id`, [`${prefix}_forged_rival`, actorId])).id });
  await assert.rejects(rivalForged.attempt(), FENCE); checks++;

  // Native quarantine branch, exercised directly: the same correctly bound decision is rejected once the
  // business carries an uncleared identity quarantine, and accepted after the quarantine is cleared.
  const qProgram = randomUUID();
  await q(`INSERT INTO sfp_programs(id,name,county_fips,vertical_ids,taxonomy_version,is_active,created_by)
    VALUES($1,$2,ARRAY['12086'],ARRAY['Automotive'],2,FALSE,$3)`, [qProgram, `${prefix}_quarantine`, actorId]);
  const qCohort = (await one(`INSERT INTO sfp_cohort_runs(program_id,idempotency_key,actor_id)
    VALUES($1,$2,$3) RETURNING id`, [qProgram, `${prefix}_quarantine_cohort`, actorId])).id;
  const quarTag = tag();
  const quarantined = await forge({ candidateEmail: `info@${quarTag}.net`, contactEmail: `info@${quarTag}.net`,
    businessDomain: `${quarTag}.net` });
  await q(`INSERT INTO sfp_identity_quarantines(business_id,reason_code,suspect_domain,source_cohort_run_id)
    VALUES($1,'CERT_QUARANTINE',$2,$3)`, [quarantined.biz.id, `${quarTag}.net`, qCohort]);
  await assert.rejects(quarantined.attempt(), FENCE); checks++;
  check((await decisions(Number(quarantined.contact.id))).length === 0, "Quarantined business: native guard blocked the decision");
  await q(`UPDATE sfp_identity_quarantines SET cleared_at=now(),cleared_by=$2,clear_reason='certification' WHERE business_id=$1`,
    [quarantined.biz.id, actorId]);
  await quarantined.attempt();
  check((await decisions(Number(quarantined.contact.id))).length === 1, "After the quarantine is cleared the same decision is accepted");
  // And the application path holds quarantined businesses without touching them.
  const quarApp = await business();
  await stage(quarApp.id, `info@${quarApp.domain}`);
  await q(`INSERT INTO sfp_identity_quarantines(business_id,reason_code,suspect_domain,source_cohort_run_id)
    VALUES($1,'CERT_QUARANTINE',$2,$3)`, [quarApp.id, quarApp.domain, qCohort]);
  await run();
  check(!(await contactByEmail(`info@${quarApp.domain}`)), "Materializer never creates a contact for a quarantined business");

  // Legacy-shape and unrelated-evidence rejections that existed before.
  const victimBiz = await business();
  const victim = await one(`INSERT INTO contacts(first_name,last_name,email,phone,company_name,record_class,email_token_hash)
    VALUES('V','Ictim',$1,'','V Co','production',encode(sha256(convert_to($1::text,'UTF8')),'hex')) RETURNING *`,
    [`info@${tag()}.org`]);
  await assert.rejects(q(`INSERT INTO contact_business_link_decisions
    (contact_id,business_id,decision,decision_key,actor_id,revision)
    VALUES($1,$2,'verified',$3,'system',1)`, [victim.id, victimBiz.id, `${prefix}:no-evidence`]),
    /COMMERCIAL_SYSTEM_LINK_CONTRACT_REQUIRED/);
  checks++;
  check(Number((await one(`SELECT business_id FROM contacts WHERE id=$1`, [victim.id])).business_id ?? 0) === 0,
    "Forged attempts leave the contact unlinked");
  const anyEvidence = await one(`SELECT id FROM contact_business_first_party_link_evidence LIMIT 1`);
  await assert.rejects(q(`UPDATE contact_business_first_party_link_evidence SET rule_version='x' WHERE id=$1`, [anyEvidence.id]),
    /COMMERCIAL_FIRST_PARTY_LINK_EVIDENCE_IMMUTABLE/);
  await assert.rejects(q(`DELETE FROM contact_business_first_party_link_evidence WHERE id=$1`, [anyEvidence.id]),
    /COMMERCIAL_FIRST_PARTY_LINK_EVIDENCE_IMMUTABLE/);
  checks += 2;

  // ── Lock order: materialization vs an existing system/admin relationship writer ─────────────────
  const { decideContactBusinessLink, FIRST_PARTY_LINK_RULE_VERSION } = await import("../../server/services/commercial-link-authority");
  check(FIRST_PARTY_LINK_RULE_VERSION === "first_party_staged_email_v2", "First-party rule version advanced with the attribution contract");
  const adminId = `${prefix}_admin`;
  await q(`INSERT INTO users(id,email,role) VALUES($1,$2,'admin')`, [adminId, `${adminId}@fixture.invalid`]);
  const waitingLocks = async (needed: number) => {
    for (let i = 0; i < 100; i++) {
      const n = Number((await one(`SELECT count(*) n FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory'`)).n);
      if (n >= needed) return n;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error("LOCK_CONTENTION_NOT_REACHED");
  };
  const withTimeout = <T,>(p: Promise<T>, label: string) => Promise.race([p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`DEADLOCK_OR_HANG:${label}`)), 30000))]);
  const gateClient = await pool.connect();
  const probeClient = await pool.connect();
  try {
    for (const writer of ["admin", "graph-then-row"] as const) {
      const cBiz = await business();
      const cEmail = `info@${cBiz.domain}`;
      const cCandidate = await stage(cBiz.id, cEmail);
      const cContact = await one(`INSERT INTO contacts(first_name,last_name,email,phone,company_name,record_class)
        VALUES('Con','Tention',$1,'','Con Co','unknown') RETURNING id`, [cEmail]);
      const cId = Number(cContact.id);
      await gateClient.query("BEGIN");
      await gateClient.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,1700))`, [`cro02:v1:node:contact:${cId}`]);
      const materializer = run(500, { candidateIds: [cCandidate] });
      const relationshipWriter = writer === "admin"
        ? decideContactBusinessLink({ contactId: cId, decision: "rejected", decisionKey: `${prefix}:admin:${cId}`, reviewerId: adminId })
        : (async () => {
            const { db } = await import("../../server/db");
            const { sql } = await import("drizzle-orm");
            const { lockCommercialGraph } = await import("../../server/services/commercial-graph-locks");
            return db.transaction(async (tx: any) => {
              await tx.execute(sql`SET LOCAL lock_timeout='20s'`);
              await lockCommercialGraph(tx, [{ type: "contact", id: cId }, { type: "business", id: cBiz.id }], ["contact_business"]);
              await tx.execute(sql`SELECT id FROM contacts WHERE id=${cId} FOR UPDATE`);
              await tx.execute(sql`SELECT pg_sleep(0.3)`);
              return "locked-contact-after-graph";
            });
          })();
      await waitingLocks(2);
      // While the materializer is queued behind the graph fence it must NOT already hold the contact row.
      await probeClient.query("BEGIN");
      let rowFree = true;
      try { await probeClient.query(`SELECT id FROM contacts WHERE id=$1 FOR UPDATE NOWAIT`, [cId]); }
      catch { rowFree = false; }
      await probeClient.query("ROLLBACK");
      check(rowFree, `Materializer waits on the graph fence without holding the contact row (${writer} writer)`);
      await gateClient.query("COMMIT");
      const [mat] = await Promise.all([withTimeout(materializer, `materializer:${writer}`),
        withTimeout(Promise.resolve(relationshipWriter), `writer:${writer}`)]);
      check(mat.failed === 0, `Materializer and ${writer} writer both completed without deadlock or failure`);
      const current = await q(`SELECT decision FROM contact_business_link_decisions WHERE contact_id=$1 AND superseded_at IS NULL`, [cId]);
      check(current.length <= 1, `At most one current relationship decision remains (${writer} writer)`);
      if (writer === "admin") {
        check(current.length === 1, "The completed admin decision is the single current decision");
      }
    }
  } finally {
    await gateClient.query("ROLLBACK").catch(() => {});
    gateClient.release(); probeClient.release();
  }

  // ── Ordinary automatic preparation picks the linked contact up ────────────
  const programId = randomUUID();
  await q(`INSERT INTO sfp_programs(id,name,county_fips,vertical_ids,taxonomy_version,is_active,created_by)
    VALUES($1,$2,ARRAY['12086'],ARRAY['Automotive'],2,TRUE,$3)`, [programId, prefix, actorId]);
  const sequenceId = Number((await one(`INSERT INTO follow_up_sequences(name,status,trigger_type,trigger_config)
    VALUES($1,'paused','contact_created',$2::jsonb) RETURNING id`,
    [prefix, JSON.stringify({ canonicalProgramId: programId, canonicalVerticals: ["Automotive"] })])).id);
  process.env.NODE_ENV = "production";
  process.env.REPLIT_DEPLOYMENT = "1";
  process.env.RELEASE_SHA = "e".repeat(40);
  process.env.SFP_PUBLISH_ARTIFACT_SHA = process.env.RELEASE_SHA;
  process.env.SFP_PUBLISH_BUILD_ID = randomUUID();
  process.env.SFP_PUBLISH_BUILT_AT = new Date().toISOString();
  const { processCanonicalRecipientPreparationTick } =
    await import("../../server/services/canonical-recipient-preparation-worker");
  for (let pass = 0; pass < 3; pass++) await processCanonicalRecipientPreparationTick();
  const prepared = await one(`SELECT i.preparation_state,i.business_id,se.status member_status,se.next_action_at,
      se.metadata->>'outboundAuthorized' authorized
    FROM cr04_enrollment_intents i JOIN sequence_enrollments se ON se.id=i.enrollment_id
    WHERE i.contact_id=$1 AND i.program_id=$2`, [roleContact.id, programId]);
  check(prepared && prepared.preparation_state === "pending_validation" && Number(prepared.business_id) === shop.id
    && prepared.member_status === "paused" && prepared.next_action_at == null && prepared.authorized === "false",
    "Linked role contact is selected by the ordinary preparation tick: pending-validation intent for the original business, paused, no send authority");
  const roleFresh = await one(`SELECT id,email_token_hash,email_mutation_generation FROM contacts WHERE id=$1`, [roleContact.id]);
  const intent = await one(`SELECT state,enqueue_state,operation_id,subject_generation,policy_version,purpose
    FROM validation_intents WHERE contact_id=$1 AND normalized_email_token_hash=$2 AND subject_generation=$3`,
    [roleContact.id, roleFresh.email_token_hash, roleFresh.email_mutation_generation]);
  check(intent && intent.state === "pending" && intent.operation_id == null && intent.purpose === "marketing_outreach"
    && Number(roleFresh.email_mutation_generation) >= 1
    && Number((await one(`SELECT count(*) n FROM validation_intents WHERE contact_id=$1`, [roleContact.id])).n) === 1,
    "Preparation created the actual pending validation intent for the exact contact, address hash and generation (no provider operation)");
  check(!(await one(`SELECT 1 FROM sequence_enrollments WHERE contact_id=$1`, [gmailContact.id])),
    "Business with no mapped vertical program is linked but not prepared (vertical/program eligibility stays separate)");

  const after = await one(`SELECT
    (SELECT count(*) FROM provider_operations)::int operations,
    (SELECT count(*) FROM communication_events)::int communications,
    (SELECT count(*) FROM sfp_cohort_runs)::int cohorts`);
  check(after.operations === before.operations && after.communications === before.communications
    && after.cohorts === before.cohorts + 1, "No provider operations or communications were created; the only cohort row is the quarantine fixture's");
  check(getBlockedCertificationNetworkAttemptCount() === 0, "No attempted provider/network transport");
  console.log(`PASS: ${checks} staged-email materialization checks; local-only, no provider calls or messages`);
} finally { await pool.end(); }
