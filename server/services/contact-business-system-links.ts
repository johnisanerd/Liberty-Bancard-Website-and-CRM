import crypto from "node:crypto";
import { loadEvidenceRelationshipPage } from "./contact-business-evidence-page";
import { sql } from "drizzle-orm";
import { db } from "../db";
import {
  assertSfpLinkDatabaseGuard,
  assertSystemLinkDatabaseGuard,
  decideSystemContactBusinessLink,
} from "./commercial-link-authority";
import {
  evaluateSystemLinkFacts,
  normalizeSystemBusinessDomain,
  normalizeSystemBusinessName,
  type SystemLinkFacts,
} from "./contact-business-system-link-policy";
export {
  evaluateSystemLinkFacts,
  normalizeSystemBusinessDomain,
  normalizeSystemBusinessName,
  type SystemLinkFacts,
} from "./contact-business-system-link-policy";

export const CONTACT_BUSINESS_SYSTEM_LINK_RULE = "crm_evidence_identity_v3";

function snapshotHash(facts: SystemLinkFacts): string {
  return crypto.createHash("sha256").update(JSON.stringify(minimizedEvidenceFacts(facts))).digest("hex");
}

function minimizedEvidenceFacts(f: SystemLinkFacts) {
  const email = String(f.contactEmail ?? "").trim().toLowerCase().split("@");
  return {
    ruleVersion: CONTACT_BUSINESS_SYSTEM_LINK_RULE,
    identityRevision: f.identityRevision,
    relationshipReasons: f.relationshipReasons,
    contactId: f.contactId,
    businessId: f.businessId,
    sourceLinkId: f.sourceLinkId,
    sourceEntityId: f.sourceEntityId,
    companyNameNormalized: normalizeSystemBusinessName(f.companyName),
    canonicalNameNormalized: normalizeSystemBusinessName(f.canonicalName),
    sunbizNameNormalized: normalizeSystemBusinessName(f.sunbizName),
    contactWebsiteDomain: normalizeSystemBusinessDomain(f.contactWebsite),
    businessDomain: normalizeSystemBusinessDomain(f.businessDomain),
    sunbizWebsiteDomain: normalizeSystemBusinessDomain(f.sunbizWebsite),
    contactEmailDomain: email.length === 2 ? email[1] : null,
    contactRecordClass: f.contactRecordClass,
    emailStatus: f.emailStatus,
    archived: f.archivedAt != null,
    existingMerchantCustomer: f.existingMerchantCustomer,
    doNotContact: f.doNotContact,
    doNotAutoContact: f.doNotAutoContact,
    optedOutEmail: f.optedOutEmail,
    optOutStatus: f.optOutStatus,
    unsubscribeStatus: f.unsubscribeStatus,
    bounceStatus: f.bounceStatus,
    complaintStatus: f.complaintStatus,
    suppressed: Boolean(f.suppressionReason),
    businessRecordClass: f.businessRecordClass,
    doNotVisit: f.doNotVisit,
    sourceSystem: f.sourceSystem,
    sourceType: f.sourceType,
    sourceStableKey: f.sourceStableKey,
    sunbizEntitySource: f.sunbizEntitySource,
    filingNumber: f.filingNumber,
    domainBusinessCount: f.domainBusinessCount,
    currentDecisionId: f.currentDecisionId,
    currentDecision: f.currentDecision,
    projectedBusinessId: f.projectedBusinessId,
  };
}

function factsFromRows(contact: any, business: any, source: any, domainBusinessCount: number): SystemLinkFacts {
  return {
    contactId: Number(contact.contact_id), businessId: Number(business.business_id),
    sourceLinkId: source?.source_link_id ? String(source.source_link_id) : null,
    sourceEntityId: source?.source_entity_id == null ? null : Number(source.source_entity_id),
    companyName: contact.company_name ?? null, contactWebsite: contact.contact_website ?? null,
    contactEmail: contact.contact_email ?? null, contactRecordClass: contact.contact_record_class ?? null,
    emailStatus: contact.email_status ?? null,
    archivedAt: contact.archived_at ?? null, existingMerchantCustomer: Boolean(contact.existing_merchant_customer),
    doNotContact: Boolean(contact.do_not_contact), doNotAutoContact: Boolean(contact.do_not_auto_contact),
    optedOutEmail: Boolean(contact.opted_out_email), optOutStatus: contact.opt_out_status ?? null,
    unsubscribeStatus: contact.unsubscribe_status ?? null, bounceStatus: contact.bounce_status ?? null,
    complaintStatus: contact.complaint_status ?? null, suppressionReason: contact.suppression_reason ?? null,
    businessRecordClass: business.business_record_class ?? null, doNotVisit: Boolean(business.do_not_visit),
    canonicalName: String(business.canonical_name ?? ""), businessDomain: business.business_domain ?? null,
    sunbizName: source?.sunbiz_name ?? null, sunbizWebsite: source?.sunbiz_website ?? null,
    sourceSystem: source?.source_system ?? null, sourceType: source?.source_type ?? null,
    sourceStableKey: source?.source_stable_key ?? null,
    sunbizEntitySource: source?.sunbiz_entity_source ?? null,
    filingNumber: source?.filing_number ?? null,
    domainBusinessCount,
    currentDecisionId: contact.current_decision_id ?? null, currentDecision: contact.current_decision ?? null,
    projectedBusinessId: contact.projected_business_id == null ? null : Number(contact.projected_business_id),
  };
}

function changedContactFilter(since?: string) {
  return since ? sql`(c.updated_at >= ${since}::timestamptz OR EXISTS (
    SELECT 1 FROM businesses changed_business
     WHERE changed_business.record_class='canonical'
       AND (changed_business.updated_at >= ${since}::timestamptz OR EXISTS (
         SELECT 1 FROM canonical_source_links changed_source
          WHERE changed_source.business_id=changed_business.id AND changed_source.updated_at >= ${since}::timestamptz))
       AND NULLIF(btrim(changed_business.website_domain),'') IS NOT NULL
       AND c.website ILIKE '%' || changed_business.website_domain || '%'
  ))` : sql`TRUE`;
}
const loadPage = loadEvidenceRelationshipPage;
async function loadLegacyPage(executor: any, afterContactId: number, limit: number, onlyContactId?: number, changedSince?: string) {
  const contactResult = await executor.execute(sql`
    SELECT c.id contact_id,c.company_name,c.website contact_website,c.email contact_email,
           c.record_class contact_record_class,c.email_status,c.archived_at,
           COALESCE(c.existing_merchant_customer,false) existing_merchant_customer,
           COALESCE(c.do_not_contact,false) do_not_contact,
           COALESCE(c.do_not_auto_contact,false) do_not_auto_contact,
           COALESCE(c.opted_out_email,false) opted_out_email,c.opt_out_status,c.unsubscribe_status,
           c.bounce_status,c.complaint_status,c.suppression_reason,c.business_id projected_business_id,
           d.id current_decision_id,d.decision current_decision
      FROM contacts c
      LEFT JOIN contact_business_link_decisions d
        ON d.contact_id=c.id AND d.superseded_at IS NULL
     WHERE ${onlyContactId === undefined ? sql`c.id > ${afterContactId}` : sql`c.id = ${onlyContactId}`}
       AND c.website IS NOT NULL AND trim(c.website) <> ''
        AND ${changedContactFilter(onlyContactId === undefined ? changedSince : undefined)}
     ORDER BY c.id
     LIMIT ${limit}
  `);
  const contacts = ((contactResult as any).rows ?? contactResult ?? []) as any[];
  const pageContacts = onlyContactId === undefined ? contacts.slice(0, limit) : contacts;
  let hasMore = false;
  if (onlyContactId === undefined && pageContacts.length === limit && pageContacts.length) {
    const moreResult = await executor.execute(sql`SELECT EXISTS (
      SELECT 1 FROM contacts c
       WHERE c.id > ${Number(pageContacts[pageContacts.length - 1].contact_id)}
         AND c.website IS NOT NULL AND trim(c.website) <> ''
         AND ${changedContactFilter(changedSince)}
    ) AS more`);
    hasMore = Boolean(((moreResult as any).rows ?? moreResult ?? [])[0]?.more);
  }
  const domains = [...new Set(pageContacts
    .map(contact => normalizeSystemBusinessDomain(contact.contact_website))
    .filter((domain): domain is string => Boolean(domain)))];
  const businessByDomain = new Map<string, any[]>();
  const sourcesByBusiness = new Map<number, any[]>();
  if (domains.length) {
    const businessResult = await executor.execute(sql`
      SELECT id business_id,canonical_name,website_domain business_domain,record_class business_record_class,
             COALESCE(do_not_visit,false) do_not_visit
        FROM businesses
       WHERE record_class='canonical'
         AND lower(regexp_replace(trim(website_domain),'^www[.]','','i')) =
             ANY(ARRAY[${sql.join(domains.map(domain => sql`${domain}`), sql`, `)}]::text[])
    `);
    const businesses = ((businessResult as any).rows ?? businessResult ?? []) as any[];
    for (const business of businesses) {
      const domain = normalizeSystemBusinessDomain(business.business_domain);
      if (!domain || !domains.includes(domain)) continue;
      const bucket = businessByDomain.get(domain) ?? [];
      bucket.push(business);
      businessByDomain.set(domain, bucket);
    }
    const businessIds = businesses.map(b => Number(b.business_id));
    if (businessIds.length) {
      const sourceResult = await executor.execute(sql`
        SELECT csl.business_id,csl.id source_link_id,csl.source_system,csl.source_type,
               csl.stable_key source_stable_key,se.id source_entity_id,se.entity_name sunbiz_name,
               se.website sunbiz_website,se.filing_number,se.source sunbiz_entity_source
          FROM canonical_source_links csl
          LEFT JOIN sunbiz_entities se
            ON se.source IN ('cordata','corevt','sunbiz') AND se.filing_number=csl.stable_key
          WHERE csl.business_id = ANY(ARRAY[${sql.join(businessIds.map(id => sql`${id}`), sql`, `)}]::integer[])
           AND csl.source_system='sunbiz' AND csl.source_type='sunbiz_entity'
      `);
      for (const source of ((sourceResult as any).rows ?? sourceResult ?? []) as any[]) {
        const bucket = sourcesByBusiness.get(Number(source.business_id)) ?? [];
        bucket.push(source);
        sourcesByBusiness.set(Number(source.business_id), bucket);
      }
    }
  }
  const selectedFactsForPage: SystemLinkFacts[] = [];
  const previews = pageContacts.map(contact => {
    const contactDomain = normalizeSystemBusinessDomain(contact.contact_website);
    const businesses = contactDomain ? (businessByDomain.get(contactDomain) ?? []) : [];
    if (!businesses.length) {
      const reasons = ["canonical_business_domain_not_found"];
      return {
        contactId: Number(contact.contact_id), businessId: null, companyName: contact.company_name ?? null,
        sourceLinkId: null, sourceEntityId: null,
        snapshotHash: crypto.createHash("sha256").update(JSON.stringify({
          contactId: Number(contact.contact_id), contactWebsiteDomain: contactDomain,
          companyNameNormalized: normalizeSystemBusinessName(contact.company_name),
          reason: reasons[0],
        })).digest("hex"),
        reasons, eligible: false,
      };
    }
    const alternatives: Array<{ facts: SystemLinkFacts; reasons: string[] }> = [];
    for (const business of businesses) {
      const sources = sourcesByBusiness.get(Number(business.business_id)) ?? [null];
      for (const source of sources) {
        const facts = factsFromRows(contact, business, source, businesses.length);
        alternatives.push({ facts, reasons: evaluateSystemLinkFacts(facts) });
      }
    }
    const eligibleAlternatives = alternatives.filter(alternative => alternative.reasons.length === 0);
    const uniquelyEligible = businesses.length === 1 && eligibleAlternatives.length === 1;
    const reasons = uniquelyEligible ? [] : [...new Set(alternatives.flatMap(alternative => alternative.reasons))];
    if (businesses.length !== 1 && !reasons.includes("canonical_business_domain_ambiguous")) {
      reasons.push("canonical_business_domain_ambiguous");
    }
    if (eligibleAlternatives.length > 1) reasons.push("independent_sunbiz_source_ambiguous");
    const chosenFacts = uniquelyEligible ? eligibleAlternatives[0].facts : null;
    if (chosenFacts) selectedFactsForPage.push(chosenFacts);
    const hashFacts = chosenFacts
      ? minimizedEvidenceFacts(chosenFacts)
      : alternatives.map(alternative => minimizedEvidenceFacts(alternative.facts));
    return {
      contactId: Number(contact.contact_id),
      businessId: businesses.length === 1 ? Number(businesses[0].business_id) : null,
      companyName: contact.company_name ?? null,
      sourceLinkId: uniquelyEligible ? chosenFacts!.sourceLinkId : null,
      sourceEntityId: uniquelyEligible ? chosenFacts!.sourceEntityId : null,
      snapshotHash: crypto.createHash("sha256").update(JSON.stringify(hashFacts)).digest("hex"),
      reasons,
      eligible: uniquelyEligible,
    };
  });
  return {
    previews, hasMore,
    lastContactId: pageContacts.length ? Number(pageContacts[pageContacts.length - 1].contact_id) : null,
    selectedFacts: selectedFactsForPage[0],
  };
}

export async function previewContactBusinessSystemLinks(
  input: { afterContactId: number; limit: number; changedSince?: string },
  executor: Pick<typeof db, "execute"> = db,
) {
  const limit = Math.max(1, Math.min(25, Math.floor(input.limit)));
  // The read-only inventory remains useful before the production SQL contracts
  // are installed. Only the write path is gated on those contracts.
  let schemaReady = true;
  let sfpTypedLinkSchemaReady = true;
  try {
    await assertSystemLinkDatabaseGuard(executor);
  } catch (error: any) {
    if (error?.message !== "COMMERCIAL_SYSTEM_LINK_DATABASE_GUARD_MISSING") throw error;
    schemaReady = false;
  }
  try {
    await assertSfpLinkDatabaseGuard(executor);
  } catch (error: any) {
    if (error?.message !== "COMMERCIAL_SFP_LINK_DATABASE_GUARD_MISSING"
        && error?.message !== "COMMERCIAL_SYSTEM_LINK_DATABASE_GUARD_MISSING") throw error;
    sfpTypedLinkSchemaReady = false;
  }
   if (!schemaReady) return {
     rows: [],nextCursor: null,schemaReady,sfpTypedLinkSchemaReady,writes: 0,paidProviderCalls: 0,
     unavailableReason: "COMMERCIAL_SYSTEM_LINK_DATABASE_GUARD_MISSING",
   };
   const page = await loadPage(executor, input.afterContactId, limit, undefined, input.changedSince);
  return {
    rows: page.previews,
    nextCursor: page.hasMore ? page.lastContactId : null,
    schemaReady,
    sfpTypedLinkSchemaReady,
    writes: 0,
    paidProviderCalls: 0,
  };
}

export interface SystemLinkApplyItem {
  contactId: number; businessId: number; sourceLinkId: string; sourceEntityId: number | null; snapshotHash: string;
}

export function isCurrentSystemLinkSnapshot(
  preview: { contactId: number; businessId: number | null; sourceLinkId: string | null; sourceEntityId: number | null; snapshotHash: string; eligible: boolean } | undefined,
  item: SystemLinkApplyItem,
): boolean {
  return Boolean(preview?.eligible && preview.contactId === item.contactId && preview.businessId === item.businessId
    && preview.sourceLinkId === item.sourceLinkId && preview.sourceEntityId === item.sourceEntityId
    && preview.snapshotHash === item.snapshotHash);
}

export function isMatchingSystemLinkReplay(
  replay: { contact_id: unknown; business_id: unknown; facts_hash: unknown; source_link_id: unknown; source_entity_id: unknown },
  item: SystemLinkApplyItem,
): boolean {
  return Number(replay.contact_id) === item.contactId && Number(replay.business_id) === item.businessId
    && replay.facts_hash === item.snapshotHash && String(replay.source_link_id) === item.sourceLinkId
    && (replay.source_entity_id == null ? null : Number(replay.source_entity_id)) === item.sourceEntityId;
}

export async function applyContactBusinessSystemLink(
  item: SystemLinkApplyItem, programAuthorityCheck?: (tx: any) => Promise<boolean>,
) {
  try {
    await assertSystemLinkDatabaseGuard(db);
    const key = `sfp-system-link-v1:${item.contactId}:${item.businessId}:${item.sourceLinkId}:${item.sourceEntityId}:${item.snapshotHash}`;
    const replay = (await db.execute(sql`SELECT d.id,d.contact_id,d.business_id,e.facts_hash,
        e.source_link_id,e.source_entity_id
      FROM contact_business_link_decisions d
      JOIN contact_business_system_link_evidence e ON e.id=d.system_evidence_id
      WHERE d.decision_key=${key}`) as any).rows?.[0];
    if (replay) {
      if (isMatchingSystemLinkReplay(replay, item)) {
        return { contactId: item.contactId, businessId: item.businessId, status: "replayed", decisionId: replay.id };
      }
      return { contactId: item.contactId, status: "rejected", code: "COMMERCIAL_LINK_DIVERGENT_REPLAY" };
    }
    const page = await loadPage(db, 0, 1, item.contactId);
    const preview = page.previews[0];
    if (!isCurrentSystemLinkSnapshot(preview, item)) {
      return { contactId: item.contactId, status: "rejected", code: "SYSTEM_LINK_SNAPSHOT_STALE" };
    }
    // The hash has no contact email/local-part or raw website values, and the
    // evidence JSON stores only minimized normalized facts.
    const facts = page.selectedFacts as SystemLinkFacts | undefined;
    if (!facts) return { contactId: item.contactId, status: "rejected", code: "SYSTEM_LINK_SNAPSHOT_STALE" };
    const decision = await decideSystemContactBusinessLink({
      contactId: item.contactId,
      businessId: item.businessId,
      sourceLinkId: item.sourceLinkId,
      sourceEntityId: item.sourceEntityId,
      decisionKey: key,
      ruleVersion: CONTACT_BUSINESS_SYSTEM_LINK_RULE,
      factsHash: item.snapshotHash,
      facts: minimizedEvidenceFacts(facts) as unknown as Record<string, unknown>,
      beforeGraphLock: programAuthorityCheck ? async (tx:any) => {
        if (!await programAuthorityCheck(tx)) throw new Error("SYSTEM_LINK_SNAPSHOT_STALE");
      } : undefined,
      authorityCheck: async (tx: any) => {
        const freshPage = await loadPage(tx, 0, 1, item.contactId);
        const freshPreview = freshPage.previews[0];
        return isCurrentSystemLinkSnapshot(freshPreview, item)
          && (!programAuthorityCheck || await programAuthorityCheck(tx));
      },
    });
    return {
      contactId: item.contactId, businessId: item.businessId,
      status: (decision as any).replayed ? "replayed" : "applied",
      decisionId: (decision as any).id, revision: (decision as any).revision,
    };
  } catch (error: any) {
    const code = String(error?.message ?? "SYSTEM_LINK_APPLY_FAILED").split("\n")[0].slice(0, 160);
    return { contactId: item.contactId, status: "rejected", code };
  }
}