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
  scope?: "role" | "named"; source?: string; domain?: string; person?: string; title?: string;
} = {}) {
  const sealed = seal("email", email);
  const domain = opts.domain ?? email.split("@")[1] ?? "unknown.net";
  const r = await one(`INSERT INTO free_discovery_candidates
    (generation_id,field,subject_type,business_id,domain,source,attribution_scope,person_name_evidence,
     person_title_evidence,disposition,confidence,envelope_ciphertext,envelope_nonce,envelope_tag,
     envelope_key_version,normalized_value_hash,masked_value)
    VALUES($1,'email','business',$2,$3,$4,$5,$6,$7,'staged',80,$8,$9,$10,1,$11,$12) RETURNING id`,
    [generationId, businessId, domain, opts.source ?? "first_party_contact_page", opts.scope ?? "role",
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
  check((attributeStagedAddress("a@mail.shop.com", "www.shop.com", null) as any).basis === "business_domain", "Subdomain of the business site is its own domain");

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
    && evidence.attribution_scope === "role" && evidence.address_domain === shop.domain,
    "Evidence pins candidate, business-domain basis and role scope");
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
  const gmailCandidate = await stage(unmapped.id, gmail, { source: "contact_page" });
  const gmailRun = await run();
  console.log("gmail run", JSON.stringify(gmailRun), JSON.stringify(await outcome(gmailCandidate)));
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
  const thirdPartyCandidate = await stage(thirdParty.id, `ola@${tag()}.no`, { domain: `${tag()}.no` });
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
  await stage(rivalB.id, rivalEmail, { domain: rivalEmail.split("@")[1] });

  const contradictions = await run();
  const held = async (id: string, code: string) => {
    const o = await outcome(id);
    return o?.outcome === "held" && o.reason_code === code;
  };
  check(await held(elsewhereCandidate, "EXISTING_CONTACT_LINKED_ELSEWHERE")
    && Number((await one(`SELECT business_id FROM contacts WHERE id=$1`, [linkedElsewhere.id])).business_id) === otherBiz.id,
    "Contact already tied to another business is held and untouched");
  check(await held(thirdPartyCandidate, "THIRD_PARTY_DOMAIN"), "Third-party domain held");
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
  const victimBiz = await business();
  const victim = await one(`INSERT INTO contacts(first_name,last_name,email,phone,company_name,record_class,email_token_hash)
    VALUES('V','Ictim',$1,'','V Co','production',encode(sha256(convert_to($1::text,'UTF8')),'hex')) RETURNING *`,
    [`info@${tag()}.org`]);
  const forgedCandidate = await stage(victimBiz.id, `info@${victimBiz.domain}`);
  const insertForged = async (key: string, over: Record<string, unknown> = {}) => {
    const v = { domain: victim.email.split("@")[1], basis: "business_domain", hash: victim.email_token_hash, ...over };
    const ev = await one(`INSERT INTO contact_business_first_party_link_evidence
      (decision_key,contact_id,business_id,candidate_id,candidate_hash,contact_email_token_hash,address_domain,
       domain_basis,attribution_scope,candidate_source,rule_version,facts_hash,facts)
      SELECT $1,$2,$3,fc.id,fc.normalized_value_hash,$4,$5,$6,fc.attribution_scope,fc.source,'forged','x','{}'::jsonb
        FROM free_discovery_candidates fc WHERE fc.id=$7 RETURNING id`,
      [key, victim.id, victimBiz.id, v.hash, v.domain, v.basis, forgedCandidate]);
    return q(`INSERT INTO contact_business_link_decisions
      (contact_id,business_id,decision,decision_key,actor_id,revision,first_party_evidence_id)
      VALUES($1,$2,'verified',$3,'system',1,$4)`, [victim.id, victimBiz.id, key, ev.id]);
  };
  await assert.rejects(insertForged(`${prefix}:forged-domain`), /COMMERCIAL_FIRST_PARTY_LINK_AUTHORITY_FENCE_LOST/);
  checks++;
  await assert.rejects(insertForged(`${prefix}:forged-provider`, { basis: "provider_mailbox" }),
    /COMMERCIAL_FIRST_PARTY_LINK_AUTHORITY_FENCE_LOST/);
  checks++;
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
  check(!(await one(`SELECT 1 FROM sequence_enrollments WHERE contact_id=$1`, [gmailContact.id])),
    "Business with no mapped vertical program is linked but not prepared (vertical/program eligibility stays separate)");

  const after = await one(`SELECT
    (SELECT count(*) FROM provider_operations)::int operations,
    (SELECT count(*) FROM communication_events)::int communications,
    (SELECT count(*) FROM sfp_cohort_runs)::int cohorts`);
  check(after.operations === before.operations && after.communications === before.communications
    && after.cohorts === before.cohorts, "No provider operations, communications or cohorts were created");
  check(getBlockedCertificationNetworkAttemptCount() === 0, "No attempted provider/network transport");
  console.log(`PASS: ${checks} staged-email materialization checks; local-only, no provider calls or messages`);
} finally { await pool.end(); }
