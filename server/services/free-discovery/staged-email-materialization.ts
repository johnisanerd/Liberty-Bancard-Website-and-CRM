/**
 * Staged-email materialization.
 *
 * "Staged" emails are rows in free_discovery_candidates (field='email',
 * disposition='staged'): addresses the first-party contact-page crawler and
 * JSON-LD reader found on a business's own website. They are encrypted
 * evidence that already names its business (business_id), so nothing here
 * re-matches by company name and no second business is ever created.
 *
 * For each safe candidate this service, in ONE transaction:
 *   1. verifies the sealed address (decrypts, re-hashes against the candidate,
 *      rejects non-addresses/placeholders) and its attribution to the business
 *      (address domain == the business/crawled site domain, or a mailbox-
 *      provider address published on the business's own page);
 *   2. creates the contact through writeContact(), or safely reuses the one
 *      existing unlinked contact that owns that address;
 *   3. writes the verified link to that exact business through the existing
 *      commercial link authority (first-party evidence kind, native-guarded);
 *   4. gives the contact its initial production class from that verified link.
 * Genuine contradictions (shared address across businesses, shared-domain
 * location ambiguity, third-party domains, an existing contact tied elsewhere)
 * are recorded as durable holds and retried only after the rule version
 * changes or HOLD_RETRY_HOURS pass; no routine manual approval is involved.
 *
 * It does NOT validate, enroll or send. Ordinary canonical recipient
 * preparation selects the linked production contact, reuses a suitable
 * validation receipt or creates the existing validation intent under current
 * provider controls. Business assignment never depends on ZeroBounce state,
 * vertical programs, campaign activation or recipient limits. The per-business
 * cap below is only batch volume control and counts usable contacts, never
 * invalid/bounced/suppressed/archived ones. Candidate evidence rows are never
 * mutated.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { unseal } from "../cro03/candidate-evidence-service";
import { writeContact } from "../contact-writer";
import { hashEmailToken, normalizeEmailToken } from "../provider-readiness-control";
import { isCanonicallySuppressed } from "../cro03/sfp-outreach-policy";
import { businessLacksDbprLineageSql } from "../dbpr";
import { effectiveBusinessVerticalStatusSql } from "@shared/effective-vertical";
import { decideFirstPartyContactBusinessLink } from "../commercial-link-authority";
import { initializeFirstPartyLinkedContactClass } from "../commercial-classification-authority";

const rows = (result: any): any[] => result?.rows ?? result ?? [];

export const MAX_USABLE_CONTACTS_PER_BUSINESS = 3;
export const STAGED_EMAIL_EVENT_PREFIX = "free_discovery_materialize:";
export const MATERIALIZATION_RULE_VERSION = "staged_email_materialization_v2";
export const HOLD_RETRY_HOURS = 24;

const CLEAN_ADDRESS = /^[a-z0-9][a-z0-9._%+'-]{0,63}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const PLACEHOLDER_DOMAINS = new Set([
  "example.com", "example.org", "email.com", "domain.com", "yourdomain.com", "yoursite.com",
  "mysite.com", "test.com", "sentry.io", "wixpress.com", "sentry-next.wixpress.com", "godaddy.com",
]);
const PLACEHOLDER_LOCALS = new Set([
  "name", "yourname", "user", "username", "email", "youremail", "test", "example", "sample", "you",
]);
const MAILBOX_PROVIDER_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "outlook.com", "hotmail.com", "live.com",
  "aol.com", "icloud.com", "me.com", "msn.com", "proton.me", "protonmail.com", "mail.com",
  "comcast.net", "att.net", "bellsouth.net", "sbcglobal.net", "verizon.net", "cox.net",
]);

const stripWww = (value: unknown) =>
  String(value ?? "").trim().toLowerCase().replace(/^www\./, "");
const nameToken = (value: unknown) => String(value ?? "").toLowerCase()
  .replace(/\b(incorporated|inc|limited|ltd|llc|llp|corp|corporation|company|co)\b/g, "")
  .replace(/[^a-z0-9]/g, "");

export type AddressAttribution =
  | { ok: true; domain: string; basis: "business_domain" | "provider_mailbox" }
  | { ok: false; reason: string };

/** Pure: is this address plausibly the business's own published mailbox? */
export function attributeStagedAddress(
  email: string, candidateDomain: unknown, businessDomain: unknown,
): AddressAttribution {
  if (!CLEAN_ADDRESS.test(email) || email.length > 254 || email.includes("..")) {
    return { ok: false, reason: "EMAIL_NOT_CLEAN" };
  }
  const [local, domain] = email.split("@");
  if (PLACEHOLDER_DOMAINS.has(domain) || PLACEHOLDER_LOCALS.has(local)) {
    return { ok: false, reason: "PLACEHOLDER_ADDRESS" };
  }
  // A mailbox-provider domain is never "the business's own site", even if a
  // crawler recorded it as the candidate domain.
  const own = [stripWww(candidateDomain), stripWww(businessDomain)]
    .filter(d => d && !MAILBOX_PROVIDER_DOMAINS.has(d));
  if (own.some(d => domain === d || domain.endsWith(`.${d}`))) {
    return { ok: true, domain, basis: "business_domain" };
  }
  if (MAILBOX_PROVIDER_DOMAINS.has(domain)) return { ok: true, domain, basis: "provider_mailbox" };
  return { ok: false, reason: "THIRD_PARTY_DOMAIN" };
}

export interface MaterializationScope {
  /** Default 'all': association never depends on vertical, so unmapped
   * businesses are linked too (mapped ones are simply processed first).
   * 'mapped' restricts a batch to businesses outreach can use today. */
  verticalScope?: "mapped" | "all";
}

/** Candidate rows that pass every database-side gate, ranked per business. */
function eligibleCandidatesSql(limit: number | null, scope: MaterializationScope = {}) {
  const mappedOnly = scope.verticalScope === "mapped";
  return sql`
    WITH staged AS MATERIALIZED (
      SELECT f.id, f.business_id, f.normalized_value_hash, f.confidence, f.created_at,
             f.envelope_ciphertext, f.envelope_nonce, f.envelope_tag, f.envelope_key_version,
             f.source, f.attribution_scope, f.domain, f.person_name_evidence, f.person_title_evidence
        FROM free_discovery_candidates f
        LEFT JOIN free_discovery_materialization_outcomes o ON o.candidate_id = f.id
       WHERE f.field = 'email' AND f.disposition = 'staged' AND f.subject_type = 'business'
         AND f.business_id IS NOT NULL AND f.promoted_at IS NULL
         AND (o.candidate_id IS NULL
              OR (o.outcome = 'held' AND (o.rule_version <> ${MATERIALIZATION_RULE_VERSION}
                  OR o.evaluated_at < now() - make_interval(hours => ${HOLD_RETRY_HOURS}))))
    ), eligible_business AS MATERIALIZED (
      SELECT b.id,
             (SELECT count(*) FROM contacts c
               WHERE c.business_id = b.id AND c.archived_at IS NULL
                 AND COALESCE(c.do_not_contact, FALSE) = FALSE
                 AND COALESCE(c.opted_out_email, FALSE) = FALSE
                 AND COALESCE(c.bounce_status, 'none') <> 'hard'
                 AND COALESCE(c.email_status, 'unvalidated') NOT IN ('invalid','bounced','unsafe','opted_out')
                 AND c.suppression_reason IS NULL) AS usable_contacts,
             (${sql.raw(effectiveBusinessVerticalStatusSql("b"))} = 'mapped') AS vertical_mapped
        FROM businesses b
       WHERE b.id IN (SELECT business_id FROM staged)
         AND b.record_class = 'canonical' AND COALESCE(b.do_not_visit, FALSE) = FALSE
         AND ${businessLacksDbprLineageSql(sql`b.id`)}
         AND NOT EXISTS (SELECT 1 FROM sfp_identity_quarantines q
                          WHERE q.business_id = b.id AND q.cleared_at IS NULL)
         ${mappedOnly ? sql`AND ${sql.raw(effectiveBusinessVerticalStatusSql("b"))} = 'mapped'` : sql``}
    ), shared_hash AS MATERIALIZED (
      SELECT normalized_value_hash FROM staged
       GROUP BY normalized_value_hash HAVING count(DISTINCT business_id) > 1
    ), base AS (
      SELECT s.*, eb.usable_contacts, eb.vertical_mapped
        FROM staged s
        JOIN eligible_business eb ON eb.id = s.business_id
       WHERE s.normalized_value_hash NOT IN (SELECT normalized_value_hash FROM shared_hash)
    ), ranked AS (
      SELECT base.*,
             row_number() OVER (PARTITION BY business_id
               ORDER BY (attribution_scope = 'named') DESC, confidence DESC NULLS LAST,
                        created_at, id) AS rn
        FROM base
    )
    SELECT * FROM ranked
     WHERE rn <= GREATEST(0, ${MAX_USABLE_CONTACTS_PER_BUSINESS} - usable_contacts)
     ORDER BY vertical_mapped DESC, business_id, rn
     ${limit ? sql`LIMIT ${limit}` : sql``}
  `;
}

export interface StagedEmailMaterializationPreview {
  stagedBusinessEmailRows: number;
  eligibleRows: number;
  eligibleBusinesses: number;
  note: string;
}

/** Read-only: how many staged rows would be evaluated right now. */
export async function previewStagedEmailMaterialization(
  scope: MaterializationScope = {},
): Promise<StagedEmailMaterializationPreview> {
  const total = rows(await db.execute(sql`
    SELECT count(*)::int AS n FROM free_discovery_candidates
     WHERE field='email' AND disposition='staged' AND subject_type='business' AND business_id IS NOT NULL
  `))[0];
  const eligible = rows(await db.execute(sql`
    SELECT count(*)::int AS n, count(DISTINCT business_id)::int AS businesses
      FROM (${eligibleCandidatesSql(null, scope)}) e
  `))[0];
  return {
    stagedBusinessEmailRows: Number(total?.n ?? 0),
    eligibleRows: Number(eligible?.n ?? 0),
    eligibleBusinesses: Number(eligible?.businesses ?? 0),
    note: "Database-side gates only; address cleanliness, domain attribution, existing-contact identity and suppression are re-checked per row inside the write transaction.",
  };
}

export interface StagedEmailMaterializationResult {
  examined: number;
  /** New contacts created and linked. */
  created: number;
  /** Existing unlinked contacts reused and linked. */
  linkedExisting: number;
  /** Existing contacts already linked to the same business (no change). */
  alreadyLinked: number;
  held: Record<string, number>;
  skipped: Record<string, number>;
  failed: number;
  contactIds: number[];
}

class MaterializationHold extends Error {
  constructor(readonly code: string) { super(code); }
}

async function recordOutcome(
  executor: { execute: (q: any) => Promise<any> },
  candidateId: string, outcome: "linked" | "already_linked" | "held",
  reason: string | null, contactId: number | null, businessId: number,
) {
  await executor.execute(sql`
    INSERT INTO free_discovery_materialization_outcomes
      (candidate_id, outcome, reason_code, contact_id, business_id, rule_version, evaluated_at)
    VALUES (${candidateId}::uuid, ${outcome}, ${reason}, ${contactId}, ${businessId},
            ${MATERIALIZATION_RULE_VERSION}, now())
    ON CONFLICT (candidate_id) DO UPDATE SET outcome = EXCLUDED.outcome,
      reason_code = EXCLUDED.reason_code, contact_id = EXCLUDED.contact_id,
      business_id = EXCLUDED.business_id, rule_version = EXCLUDED.rule_version,
      evaluated_at = now()
  `);
}

type RowOutcome =
  | { kind: "created"; contactId: number }
  | { kind: "linked_existing"; contactId: number }
  | { kind: "already_linked"; contactId: number };

async function materializeCandidate(candidate: any, actorId: string): Promise<RowOutcome> {
  const candidateId = String(candidate.id);
  const businessId = Number(candidate.business_id);
  let email: string;
  try {
    email = unseal("email", {
      ciphertext: String(candidate.envelope_ciphertext),
      nonce: String(candidate.envelope_nonce),
      tag: String(candidate.envelope_tag),
      keyVersion: Number(candidate.envelope_key_version ?? 1),
    }).trim().toLowerCase();
  } catch {
    throw new MaterializationHold("DECRYPTION_FAILED");
  }
  // The sealed value must be the exact address this candidate row attests.
  const candidateHash = createHash("sha256").update(`email\0${email}`).digest("hex");
  if (candidateHash !== String(candidate.normalized_value_hash)) {
    throw new MaterializationHold("CANDIDATE_HASH_MISMATCH");
  }
  if (!normalizeEmailToken(email)) throw new MaterializationHold("EMAIL_NOT_CLEAN");
  const tokenHash = hashEmailToken(email);
  if (!tokenHash) throw new MaterializationHold("EMAIL_NOT_CLEAN");

  const business = rows(await db.execute(sql`
    SELECT canonical_name, vertical, website_domain FROM businesses WHERE id = ${businessId}
  `))[0];
  const companyName = String(business?.canonical_name ?? "").trim();
  if (!companyName) throw new MaterializationHold("BUSINESS_NAME_MISSING");

  const attribution = attributeStagedAddress(email, candidate.domain, business?.website_domain);
  if (!attribution.ok) throw new MaterializationHold(attribution.reason);
  if (await isCanonicallySuppressed([tokenHash], db, [email])) throw new MaterializationHold("SUPPRESSED");

  const scope = candidate.attribution_scope === "named" ? "named" : "role";
  const personName = scope === "named" ? String(candidate.person_name_evidence ?? "").trim() : "";
  const personParts = personName.split(/\s+/).filter(Boolean);
  // Role mailboxes never get an invented person: the business name stands in
  // as the display placeholder and the provenance says so.
  const namedPerson = scope === "named" && personParts.length >= 2;
  const firstName = namedPerson ? personParts[0].slice(0, 60) : companyName.slice(0, 60);
  const lastName = namedPerson ? personParts.slice(1).join(" ").slice(0, 60) : "Contact";

  return db.transaction(async (tx) => {
    // Serialize concurrent runs on the candidate and on the address itself.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`staged_email_candidate:${candidateId}`}))`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`staged_email_address:${tokenHash}`}))`);

    const live = rows(await tx.execute(sql`
      SELECT f.business_id, o.outcome FROM free_discovery_candidates f
        LEFT JOIN free_discovery_materialization_outcomes o ON o.candidate_id = f.id
       WHERE f.id = ${candidateId}::uuid AND f.disposition = 'staged'
         AND f.normalized_value_hash = ${candidateHash} FOR SHARE OF f
    `))[0];
    if (!live || Number(live.business_id) !== businessId) throw new MaterializationHold("EVIDENCE_CHANGED");
    if (live.outcome === "linked" || live.outcome === "already_linked") {
      throw new MaterializationHold("ALREADY_RESOLVED");
    }

    // Shared-location ambiguity: another canonical business publishes on the
    // same site domain, so the page cannot say which business owns the mailbox.
    if (attribution.basis === "business_domain") {
      const shared = rows(await tx.execute(sql`
        SELECT 1 FROM businesses other
         WHERE other.id <> ${businessId} AND other.record_class = 'canonical'
           AND lower(regexp_replace(trim(coalesce(other.website_domain,'')),'^www[.]','','i'))
               IN (${stripWww(candidate.domain) || "-"}, ${stripWww(business?.website_domain) || "-"})
         LIMIT 1
      `))[0];
      if (shared) throw new MaterializationHold("SHARED_LOCATION_DOMAIN");
    }

    const existing = rows(await tx.execute(sql`
      SELECT c.id, c.business_id, c.company_name,
             (SELECT d.business_id FROM contact_business_link_decisions d
               WHERE d.contact_id = c.id AND d.superseded_at IS NULL AND d.decision = 'verified') AS verified_business_id,
             EXISTS (SELECT 1 FROM contact_business_link_decisions d
               WHERE d.contact_id = c.id AND d.superseded_at IS NULL) AS has_current_decision
        FROM contacts c
       WHERE c.archived_at IS NULL AND lower(btrim(c.email)) = ${email}
       ORDER BY c.id FOR UPDATE OF c
    `));
    let contactId: number;
    let created = false;
    if (existing.length > 1) throw new MaterializationHold("EXISTING_CONTACT_AMBIGUOUS");
    if (existing.length === 1) {
      const row = existing[0];
      contactId = Number(row.id);
      if (row.business_id != null || row.verified_business_id != null) {
        if (Number(row.business_id) === businessId && Number(row.verified_business_id) === businessId) {
          await recordOutcome(tx, candidateId, "already_linked", null, contactId, businessId);
          return { kind: "already_linked", contactId } as RowOutcome;
        }
        throw new MaterializationHold("EXISTING_CONTACT_LINKED_ELSEWHERE");
      }
      if (row.has_current_decision) throw new MaterializationHold("EXISTING_CONTACT_HAS_RELATIONSHIP_DECISION");
      // The address sits on the business's own domain, or the contact already
      // carries this business's name; otherwise a provider mailbox could be anyone.
      if (attribution.basis !== "business_domain" && nameToken(row.company_name) !== nameToken(companyName)) {
        throw new MaterializationHold("EXISTING_CONTACT_UNCORROBORATED");
      }
      // Imported legacy mailboxes have generation 0 and no token hash. Bootstrap the
      // identity exactly as canonical preparation does (under this row lock); the
      // address itself is unchanged and no provider observation is rewritten.
      await tx.execute(sql`UPDATE contacts SET email_mutation_generation=1,email_token_hash=${tokenHash}
        WHERE id=${contactId} AND email_mutation_generation=0
          AND (email_token_hash IS NULL OR email_token_hash=${tokenHash})`);
    } else {
      const written = await writeContact({
        mode: "local_only",
        transaction: tx,
        hookPolicy: {
          source: "cro03", deferValidation: true, deferReadiness: true,
          deferLeadScoring: true, suppressProviderProjection: true,
          authorityCheck: async (inner: any) => Boolean(rows(await inner.execute(sql`
            SELECT 1 FROM free_discovery_candidates
             WHERE id = ${candidateId}::uuid AND disposition = 'staged' AND promoted_at IS NULL
             FOR SHARE`))[0]),
        },
        mutation: {
          firstName, lastName,
          title: namedPerson ? (String(candidate.person_title_evidence ?? "").trim().slice(0, 120) || null) : null,
          email, phone: "", companyName,
          vertical: business?.vertical ?? null,
          status: "New",
        } as any,
        provenance: {
          sourceCategory: "discovery",
          sourceType: "free_discovery",
          eventKey: `${STAGED_EMAIL_EVENT_PREFIX}${candidateId}`,
          actorType: "system",
          actorId,
          metadata: {
            origin: "free_discovery_staged_email_materialization",
            ruleVersion: MATERIALIZATION_RULE_VERSION,
            candidateId,
            businessId,
            candidateSource: candidate.source,
            attributionScope: scope,
            addressDomainBasis: attribution.basis,
            contactNameBasis: namedPerson ? "published_person_name" : "business_name_placeholder",
          },
        },
        actor: { actorType: "system", actorId },
      });
      contactId = Number(written.id);
      created = written._intakeOutcome === "created";
      // A concurrent writer outside this lock domain may have made the address
      // first; a matched row is only usable if it is unlinked and uncontradicted.
      if (!created) {
        const matched = rows(await tx.execute(sql`
          SELECT business_id FROM contacts WHERE id = ${contactId}`))[0];
        if (matched?.business_id != null) throw new MaterializationHold("EXISTING_CONTACT_LINKED_ELSEWHERE");
      }
    }

    await decideFirstPartyContactBusinessLink({
      executor: tx,
      contactId, businessId,
      candidateId, candidateHash,
      contactEmailTokenHash: tokenHash,
      addressDomain: attribution.domain,
      domainBasis: attribution.basis,
      attributionScope: scope,
      candidateSource: String(candidate.source),
      facts: { ruleVersion: MATERIALIZATION_RULE_VERSION, contactCreated: created },
    });
    await initializeFirstPartyLinkedContactClass(contactId, tx);
    await recordOutcome(tx, candidateId, "linked", null, contactId, businessId);
    return { kind: created ? "created" : "linked_existing", contactId } as RowOutcome;
  });
}

export async function runStagedEmailMaterialization(input: {
  limit: number;
  actorId: string;
} & MaterializationScope): Promise<StagedEmailMaterializationResult> {
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit)));
  const candidates = rows(await db.execute(eligibleCandidatesSql(limit, input)));
  const result: StagedEmailMaterializationResult = {
    examined: candidates.length, created: 0, linkedExisting: 0, alreadyLinked: 0,
    held: {}, skipped: {}, failed: 0, contactIds: [],
  };
  const bump = (bucket: Record<string, number>, key: string) => { bucket[key] = (bucket[key] ?? 0) + 1; };

  for (const candidate of candidates) {
    try {
      const outcome = await materializeCandidate(candidate, input.actorId);
      result.contactIds.push(outcome.contactId);
      if (outcome.kind === "created") result.created += 1;
      else if (outcome.kind === "linked_existing") result.linkedExisting += 1;
      else result.alreadyLinked += 1;
    } catch (error: any) {
      const message = String(error?.cause?.message ?? error?.message ?? "");
      let code: string | null = null;
      if (error instanceof MaterializationHold) code = error.code;
      else if (/^COMMERCIAL_FIRST_PARTY_LINK_/.test(message)) code = message.split(/[\s:]/)[0];
      else if (message.includes("CONTACT_WRITE_AUTHORITY_FENCE_LOST")) code = "EVIDENCE_CHANGED";
      if (code === "ALREADY_RESOLVED" || code === "EVIDENCE_CHANGED") { bump(result.skipped, code.toLowerCase()); continue; }
      if (code) {
        bump(result.held, code);
        await recordOutcome(db, String(candidate.id), "held", code, null, Number(candidate.business_id))
          .catch((e: any) => console.error("[StagedEmailMaterialization] hold write failed:", e?.message));
        continue;
      }
      result.failed += 1;
      console.error("[StagedEmailMaterialization] candidate failed:", message);
    }
  }

  await db.execute(sql`
    INSERT INTO audit_logs(user_id, action, entity_type, entity_key, details, actor_type, actor_id)
    VALUES (${input.actorId}, 'staged_email_materialization_run', 'free_discovery_candidates',
            ${`run:${Date.now()}`},
            ${JSON.stringify({
              ruleVersion: MATERIALIZATION_RULE_VERSION,
              examined: result.examined, created: result.created, linkedExisting: result.linkedExisting,
              alreadyLinked: result.alreadyLinked, held: result.held, skipped: result.skipped,
              failed: result.failed, paidProviderCalls: 0, outboundChanges: 0,
            })}::jsonb, 'user', ${input.actorId})
  `).catch((error: any) => console.error("[StagedEmailMaterialization] audit write failed:", error?.message));
  return result;
}
