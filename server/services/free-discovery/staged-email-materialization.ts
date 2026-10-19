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
 *      rejects non-addresses/placeholders) and its attribution to the business:
 *      the crawled site must BE the business's own website (retained as
 *      evidence), and the address must sit on that site's domain or be a
 *      mailbox-provider address published on that same business-owned page;
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
import { southFloridaProgramZips } from "../cro03a/geography";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { unseal } from "../cro03/candidate-evidence-service";
import { writeContact } from "../contact-writer";
import { hashEmailToken, normalizeEmailToken } from "../provider-readiness-control";
import { isCanonicallySuppressed } from "../cro03/sfp-outreach-policy";
import { businessLacksDbprLineageSql } from "../dbpr";
import { effectiveBusinessVerticalStatusSql } from "@shared/effective-vertical";
import { decideFirstPartyContactBusinessLink, assertFirstPartyLinkDatabaseGuard } from "../commercial-link-authority";
import { lockCommercialGraphNodes, lockCommercialGraphMembershipSets } from "../commercial-graph-locks";
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
  | { ok: true; domain: string; basis: "business_domain" | "provider_mailbox"; crawlDomain: string }
  | { ok: false; reason: string };

/**
 * Pure: is this address the business's own published mailbox? The crawled site
 * must be the business's own website (candidate domain == business website
 * domain); an unrelated or missing crawl domain never attributes anything, not
 * even a mailbox-provider address.
 */
export function attributeStagedAddress(
  email: string, crawlDomainInput: unknown, businessDomain: unknown,
): AddressAttribution {
  if (!CLEAN_ADDRESS.test(email) || email.length > 254 || email.includes("..")) {
    return { ok: false, reason: "EMAIL_NOT_CLEAN" };
  }
  const [local, domain] = email.split("@");
  if (PLACEHOLDER_DOMAINS.has(domain) || PLACEHOLDER_LOCALS.has(local)) {
    return { ok: false, reason: "PLACEHOLDER_ADDRESS" };
  }
  const crawlDomain = stripWww(crawlDomainInput);
  const siteDomain = stripWww(businessDomain);
  if (!crawlDomain || !siteDomain || crawlDomain !== siteDomain || MAILBOX_PROVIDER_DOMAINS.has(crawlDomain)) {
    return { ok: false, reason: "CRAWL_SITE_NOT_BUSINESS_SITE" };
  }
  if (domain === crawlDomain || domain.endsWith(`.${crawlDomain}`)) {
    return { ok: true, domain, basis: "business_domain", crawlDomain };
  }
  if (MAILBOX_PROVIDER_DOMAINS.has(domain)) return { ok: true, domain, basis: "provider_mailbox", crawlDomain };
  return { ok: false, reason: "THIRD_PARTY_DOMAIN" };
}

export interface MaterializationScope {
  /** Default 'all': association never depends on vertical, so unmapped
   * businesses are linked too (mapped ones are simply processed first).
   * 'mapped' restricts a batch to businesses outreach can use today. */
  verticalScope?: "mapped" | "all";
  /** Restrict a run to specific staged candidates (targeted reconciliation). */
  candidateIds?: string[];
  /** Candidates already handled in this run that wrote no outcome row (skipped/failed); never reselected. */
  excludeCandidateIds?: string[];
}

/** Candidate rows that pass every database-side gate, ranked per business. */
function eligibleCandidatesSql(limit: number | null, scope: MaterializationScope = {}) {
  const mappedOnly = scope.verticalScope === "mapped";
  const localZips = sql`ARRAY[${sql.join(southFloridaProgramZips().map(zip => sql`${zip}`), sql`, `)}]`;
  return sql`
    WITH staged AS MATERIALIZED (
      SELECT f.id, f.business_id, f.normalized_value_hash, f.confidence, f.created_at,
             f.envelope_ciphertext, f.envelope_nonce, f.envelope_tag, f.envelope_key_version,
             f.source, f.attribution_scope, f.domain, f.person_name_evidence, f.person_title_evidence,
             (o.candidate_id IS NULL) AS never_evaluated
        FROM free_discovery_candidates f
        LEFT JOIN free_discovery_materialization_outcomes o ON o.candidate_id = f.id
       WHERE f.field = 'email' AND f.disposition = 'staged' AND f.subject_type = 'business'
          ${scope.candidateIds?.length
            ? sql`AND f.id = ANY(ARRAY[${sql.join(scope.candidateIds.map(id => sql`${id}::uuid`), sql`, `)}])`
            : sql``}
          ${scope.excludeCandidateIds?.length
            ? sql`AND f.id <> ALL(ARRAY[${sql.join(scope.excludeCandidateIds.map(id => sql`${id}::uuid`), sql`, `)}])`
            : sql``}
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
             (${sql.raw(effectiveBusinessVerticalStatusSql("b"))} = 'mapped') AS vertical_mapped,
             -- Ordering only: eligibility is decided later by the full territory resolver.
             (left(btrim(COALESCE(b.postal_code,'')),5) = ANY(${localZips}::text[])
              OR EXISTS (SELECT 1 FROM business_locations bl WHERE bl.business_id = b.id
                          AND left(btrim(COALESCE(bl.postal_code,'')),5) = ANY(${localZips}::text[]))) AS local_territory
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
      SELECT s.*, eb.usable_contacts, eb.vertical_mapped, eb.local_territory
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
     ORDER BY vertical_mapped DESC, local_territory DESC, never_evaluated DESC, business_id, rn
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
  /** Candidate pages fetched in this run (1 unless a drain bound allowed continuation). */
  pages: number;
  /** Set (and nothing is evaluated) while the native first-party link branch is not installed. */
  nativeBlocked?: string;
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
    // same site domain, so the page cannot say which business owns the mailbox
    // (applies to mailbox-provider addresses as well as business-domain ones).
    {
      const shared = rows(await tx.execute(sql`
        SELECT 1 FROM businesses other
         WHERE other.id <> ${businessId} AND other.record_class = 'canonical'
           AND lower(regexp_replace(trim(coalesce(other.website_domain,'')),'^www[.]','','i')) = ${attribution.crawlDomain}
         LIMIT 1
      `))[0];
      if (shared) throw new MaterializationHold("SHARED_LOCATION_DOMAIN");
    }

    // Canonical lock order (CRO-02): graph advisory fences BEFORE the contact row, exactly as the
    // admin/system relationship writers take them. An unlocked read only identifies which contact
    // node to fence; the row lock below re-verifies everything after the fences are held.
    const peek = rows(await tx.execute(sql`
      SELECT c.id,
             (SELECT d.business_id FROM contact_business_link_decisions d
               WHERE d.contact_id = c.id AND d.superseded_at IS NULL) AS current_business_id
        FROM contacts c
       WHERE c.archived_at IS NULL AND lower(btrim(c.email)) = ${email}
       ORDER BY c.id
    `));
    if (peek.length === 1) {
      const peekId = Number(peek[0].id);
      await lockCommercialGraphNodes(tx, [{ type: "contact", id: peekId }]);
      const hint = rows(await tx.execute(sql`
        SELECT business_id FROM contact_business_link_decisions
         WHERE contact_id = ${peekId} AND superseded_at IS NULL`))[0];
      const fenceNodes = [
        { type: "contact" as const, id: peekId },
        { type: "business" as const, id: businessId },
        ...(hint?.business_id ? [{ type: "business" as const, id: Number(hint.business_id) }] : []),
      ];
      await lockCommercialGraphNodes(tx, fenceNodes.filter(node => node.type === "business"));
      await lockCommercialGraphMembershipSets(tx, fenceNodes, ["contact_business"]);
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
    // Anything that changed between the fence and the row lock was written by a writer that did not
    // hold our fences; retry on the next pass instead of acting on a moved target.
    if (existing.length !== peek.length
        || existing.some((row, i) => Number(row.id) !== Number(peek[i].id))) {
      throw new MaterializationHold("EVIDENCE_CHANGED");
    }
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
      crawlDomain: attribution.crawlDomain,
      businessSiteDomain: stripWww(business?.website_domain),
      attributionScope: scope,
      candidateSource: String(candidate.source),
      facts: { ruleVersion: MATERIALIZATION_RULE_VERSION, contactCreated: created },
    });
    await initializeFirstPartyLinkedContactClass(contactId, tx);
    await recordOutcome(tx, candidateId, "linked", null, contactId, businessId);
    return { kind: created ? "created" : "linked_existing", contactId } as RowOutcome;
  });
}

/** Bounded continuation inside one run: keep taking pages until the queue is empty or a bound is hit. */
export interface MaterializationDrainBounds {
  /** Wall-clock budget; no new page starts after it elapses (a started page always finishes). */
  timeBudgetMs: number;
  /** Hard ceiling on candidates examined in the run. */
  maxRows: number;
}

export async function runStagedEmailMaterialization(input: {
  limit: number;
  actorId: string;
  drain?: MaterializationDrainBounds;
} & MaterializationScope): Promise<StagedEmailMaterializationResult> {
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit)));
  const drain = input.drain
    ? { timeBudgetMs: Math.max(1, Math.floor(input.drain.timeBudgetMs)), maxRows: Math.max(limit, Math.floor(input.drain.maxRows)) }
    : null;
  const startedAt = Date.now();
  // Publish installs tables/columns but not PL/pgSQL bodies or triggers. Until the owner-console
  // install has run, fail closed ONCE for the whole pass instead of rolling back every candidate.
  let nativeBlocked: string | undefined;
  try { await assertFirstPartyLinkDatabaseGuard(db); }
  catch (error: any) { nativeBlocked = String(error?.message ?? error).split("\n")[0].slice(0, 300); }
  const result: StagedEmailMaterializationResult = {
    examined: 0, created: 0, linkedExisting: 0, alreadyLinked: 0,
    held: {}, skipped: {}, failed: 0, contactIds: [], pages: 0,
    ...(nativeBlocked ? { nativeBlocked } : {}),
  };
  if (nativeBlocked) console.warn(`[StagedEmailMaterialization] blocked: ${nativeBlocked}`);
  const bump = (bucket: Record<string, number>, key: string) => { bucket[key] = (bucket[key] ?? 0) + 1; };
  // Held, linked and already-linked candidates write an outcome row and drop out of the next page.
  // Skipped and failed ones do not, so they are excluded explicitly or they would starve the queue.
  const unrecorded = new Set<string>(input.excludeCandidateIds ?? []);

  while (!nativeBlocked) {
    const pageSize = drain ? Math.min(limit, drain.maxRows - result.examined) : limit;
    if (pageSize <= 0) break;
    const candidates = rows(await db.execute(eligibleCandidatesSql(pageSize, {
      ...input, excludeCandidateIds: unrecorded.size ? [...unrecorded] : undefined,
    })));
    if (!candidates.length) break;
    result.pages += 1;
    result.examined += candidates.length;
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
        if (code === "ALREADY_RESOLVED" || code === "EVIDENCE_CHANGED") {
          bump(result.skipped, code.toLowerCase());
          unrecorded.add(String(candidate.id));
          continue;
        }
        if (code) {
          bump(result.held, code);
          const wrote = await recordOutcome(db, String(candidate.id), "held", code, null, Number(candidate.business_id))
            .then(() => true)
            .catch((e: any) => { console.error("[StagedEmailMaterialization] hold write failed:", e?.message); return false; });
          if (!wrote) unrecorded.add(String(candidate.id));
          continue;
        }
        result.failed += 1;
        unrecorded.add(String(candidate.id));
        console.error("[StagedEmailMaterialization] candidate failed:", message);
      }
    }
    if (!drain || Date.now() - startedAt >= drain.timeBudgetMs || result.examined >= drain.maxRows) break;
  }

  await db.execute(sql`
    INSERT INTO audit_logs(user_id, action, entity_type, entity_key, details, actor_type, actor_id)
    VALUES (${input.actorId}, 'staged_email_materialization_run', 'free_discovery_candidates',
            ${`run:${Date.now()}`},
            ${JSON.stringify({
              ruleVersion: MATERIALIZATION_RULE_VERSION,
              examined: result.examined, created: result.created, linkedExisting: result.linkedExisting,
              alreadyLinked: result.alreadyLinked, held: result.held, skipped: result.skipped,
              failed: result.failed, pages: result.pages, nativeBlocked: result.nativeBlocked ?? null, paidProviderCalls: 0, outboundChanges: 0,
            })}::jsonb, 'user', ${input.actorId})
  `).catch((error: any) => console.error("[StagedEmailMaterialization] audit write failed:", error?.message));
  return result;
}
