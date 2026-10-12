import { storage } from "../storage";
import { db } from "../db";
import { enrichmentRuns, businesses } from "@shared/schema";
import type { Prospect } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import OpenAI from "openai";
import { isSerperConfigured, searchBusiness as realSearchBusiness, searchBusinessEmail as realSearchBusinessEmail } from "./serper";
import { serperGateway } from "./serper-gateway";

/**
 * Test-only injection seam. Production code always resolves to the real
 * Serper functions above; scripts/test-contact-backlog-enrichment.ts
 * mutates this object's properties (not the import bindings, which ESM
 * freezes) to deterministically simulate provider outcomes — a step that
 * finds data followed by a later step that gets blocked — without
 * depending on live, non-deterministic Serper responses.
 */
export const _serperDeps = {
  searchBusiness: realSearchBusiness,
  searchBusinessEmail: realSearchBusinessEmail,
};

/**
 * Same test-injection seam as _serperDeps, for the first-party contact-page
 * crawler (task #1977) — lets tests simulate crawl outcomes deterministically
 * without making a real outbound fetch.
 */
export const _crawlerDeps = {
  crawlFirstPartyContactEmails: (domain: string) => realCrawlFirstPartyContactEmails(domain),
};
import { ingestBusinessFromContact } from "./sdr/dedupe";
import { detectProcessors } from "./sdr/processor-detector";
import { detectAds } from "./sdr/ad-detector";
import { updateContactLocalFirst } from "./contact-writer";
import { enqueueReadinessRecalculation } from "./contact-readiness";
import { logAiCall } from "./ai-audit-logger";
import { scoreDecisionMaker } from "./bounce-feedback";
import { recordDecisionMakerCandidate } from "./commercial-relationship-authority";
import {
  crawlFirstPartyContactEmails as realCrawlFirstPartyContactEmails,
  selectContactDiscoveryEmail,
  isRoleInboxEmail,
  type ContactPageCrawlResult,
} from "./sdr/contactpage-enrichment";
import {
  createFreeDiscoveryGeneration, completeFreeDiscoveryGeneration, recordFreeDiscoveryCandidate,
  getDomainCache, markDomainCrawled, newFreeDiscoveryRunKey,
} from "./free-discovery/evidence-service";

function getOpenAI() {
  return new OpenAI({ apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY, baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL });
}

interface EnrichmentResult {
  website?: string;
  vertical?: string;
  estimatedRevenue?: string;
  ownerName?: string;
  ownerEmail?: string;
  businessDescription?: string;
  painPoints?: string[];
  score: "hot" | "warm" | "cold" | "unqualified";
  scoreReason?: string;
}

async function scrapeWebsiteInfo(domain: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(`https://${domain}`, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; LibertyBancardBot/1.0)" },
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const html = await response.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 3000);
    return text;
  } catch {
    return null;
  }
}

function inferDomainFromEmail(email: string): string | null {
  if (!email) return null;
  const domain = email.split("@")[1];
  if (!domain) return null;
  const freeDomains = ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com", "mail.com", "protonmail.com"];
  if (freeDomains.includes(domain.toLowerCase())) return null;
  return domain;
}

async function enrichWithAI(prospect: Prospect, websiteText: string | null): Promise<EnrichmentResult> {
  const prompt = `You are a B2B sales intelligence analyst for Liberty Bancard, a merchant payment processing company. Analyze this business prospect and provide enrichment data.

Business Info:
- Company: ${prospect.companyName || "Unknown"}
- Email: ${prospect.email || "N/A"}
- Phone: ${prospect.phone || "N/A"}
- Location: ${prospect.city || ""} ${prospect.state || ""}
- Current Vertical: ${prospect.vertical || "Unknown"}
${websiteText ? `\nWebsite Content (excerpt):\n${websiteText}` : ""}

Provide JSON with these fields:
{
  "vertical": "best matching industry vertical (Restaurant, Retail, Professional Services, Healthcare, Auto, Salon/Spa, E-commerce, Other)",
  "estimatedRevenue": "estimated annual revenue range (Under $500K, $500K-$1M, $1M-$5M, $5M-$10M, $10M+)",
  "businessDescription": "one sentence description of what the business does",
  "painPoints": ["list of 2-3 likely payment processing pain points based on their business type"],
  "score": "hot/warm/cold/unqualified - based on likelihood they'd benefit from payment processing optimization",
  "scoreReason": "brief reason for the score"
}

Scoring criteria:
- HOT: High-volume business (restaurant, retail, healthcare) with clear payment processing needs
- WARM: Medium-volume or service business that likely processes cards
- COLD: Low volume or unclear needs but could be a fit
- UNQUALIFIED: Non-profit, government, or business unlikely to need merchant services`;

  const enrichMessages = [{ role: "user" as const, content: prompt }];
  try {
    const { completion: response, flagged: enrichFlagged, reviewQueueId: enrichReviewId } = await logAiCall(
      { triggerType: "enrichment", actorType: "system", rawPrompt: JSON.stringify(enrichMessages) },
      () => getOpenAI().chat.completions.create({
        model: "gpt-4o-mini",
        messages: enrichMessages,
        response_format: { type: "json_object" },
      })
    );

    if (enrichFlagged) {
      console.warn(`[AI Governance] Enrichment classification flagged (reviewQueueId=${enrichReviewId}) — deferring AI-derived data persistence pending review`);
      return { score: "cold", scoreReason: `AI classification deferred for review (reviewQueueId=${enrichReviewId})` };
    }

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("No AI response");

    const result = JSON.parse(content);
    return {
      vertical: result.vertical || undefined,
      estimatedRevenue: result.estimatedRevenue || undefined,
      businessDescription: result.businessDescription || undefined,
      painPoints: result.painPoints || [],
      score: ["hot", "warm", "cold", "unqualified"].includes(result.score) ? result.score : "cold",
      scoreReason: result.scoreReason || undefined,
    };
  } catch (err) {
    console.error("AI enrichment failed:", err);
    return { score: "cold", scoreReason: "AI enrichment failed" };
  }
}

export function computeDecisionMakerConfidence(title: string): { isDecisionMaker: boolean; confidence: number } {
  const t = title.toLowerCase();
  if (/\b(owner|ceo|chief executive|president|principal)\b/.test(t)) {
    return { isDecisionMaker: true, confidence: 95 };
  }
  if (/\b(managing member|managing partner|partner)\b/.test(t)) {
    return { isDecisionMaker: true, confidence: 80 };
  }
  if (/\b(director|vp|vice president)\b/.test(t)) {
    return { isDecisionMaker: true, confidence: 60 };
  }
  if (/\bmanager\b/.test(t)) {
    return { isDecisionMaker: false, confidence: 40 };
  }
  return { isDecisionMaker: false, confidence: 0 };
}

export async function applyDecisionMakerDetection(contactId: number, title: string): Promise<void> {
  try {
    const contact = await storage.getContact(contactId);
    if (!contact?.businessId) return;
    const { confidence } = computeDecisionMakerConfidence(title);
    await recordDecisionMakerCandidate({
      contactId, businessId: contact.businessId, source: "title_heuristic", sourceVersion: "v1", confidence,
    });
  } catch {}
}

export async function enrichProspect(prospectId: number): Promise<Prospect | null> {
  const prospect = await storage.getProspect(prospectId);
  if (!prospect) return null;

  let websiteText: string | null = null;
  let domain = prospect.website;
  let foundEmail = prospect.email || null;
  let foundPhone = prospect.phone || null;

  if (!domain && prospect.email) {
    domain = inferDomainFromEmail(prospect.email) || null;
  }

  if (isSerperConfigured() && (!domain || !foundEmail || !foundPhone)) {
    const companyName = prospect.companyName || "";
    if (companyName) {
      const serperResult = await realSearchBusiness(companyName, prospect.city || undefined, prospect.state || "FL");
      if (serperResult.website && !domain) {
        domain = serperResult.website;
      }
      if (serperResult.emails.length > 0 && !foundEmail) {
        foundEmail = serperResult.emails[0];
      }
      if (serperResult.phones.length > 0 && !foundPhone) {
        foundPhone = serperResult.phones[0];
      }

      if (!foundEmail && domain) {
        const emailResult = await realSearchBusinessEmail(companyName, domain, prospect.city || undefined);
        if (emailResult.emails.length > 0) {
          foundEmail = emailResult.emails[0];
        }
      }
    }
  }

  if (domain) {
    const cleanDomain = domain.replace(/^https?:\/\//, "").replace(/\/$/, "");
    websiteText = await scrapeWebsiteInfo(cleanDomain);
    if (!prospect.website) {
      await storage.updateProspect(prospectId, { website: cleanDomain });
    }
  }

  const result = await enrichWithAI(prospect, websiteText);

  const updates: Record<string, any> = {
    enrichedAt: new Date(),
    score: result.score,
    status: "enriched",
  };

  if (foundEmail && !prospect.email) updates.email = foundEmail;
  if (foundPhone && !prospect.phone) updates.phone = foundPhone;
  if (domain && !prospect.website) updates.website = domain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (result.vertical) updates.vertical = result.vertical;
  if (result.estimatedRevenue) updates.estimatedRevenue = result.estimatedRevenue;
  if (result.scoreReason) updates.notes = `${prospect.notes || ""}\n[AI Score: ${result.score}] ${result.scoreReason}`.trim();
  if (result.painPoints && result.painPoints.length > 0) {
    updates.tags = [...(prospect.tags || []), ...result.painPoints.map((p: string) => `pain_${p.toLowerCase().replace(/\s+/g, "_")}`)];
  }

  const updated = await storage.updateProspect(prospectId, updates);

  if (updated?.contactId) {
    try {
      const contact = await storage.getContact(updated.contactId);
      if (contact?.businessId) {
        detectProcessors(contact.businessId).catch(err =>
          console.error(`[Enrichment] Processor detection failed for business ${contact.businessId}:`, err)
        );
        detectAds(contact.businessId).catch(err =>
          console.error(`[Enrichment] Ad detection failed for business ${contact.businessId}:`, err)
        );
      }
      if (contact && contact.title) {
        await applyDecisionMakerDetection(contact.id, contact.title);
      }
    } catch {}
  }

  return updated || prospect;
}

export async function runEnrichmentJob(jobId: number): Promise<void> {
  const job = await storage.updateEnrichmentJob(jobId, { status: "running", startedAt: new Date() });
  if (!job) return;

  const [enrichRun] = await db.insert(enrichmentRuns).values({
    provider: "internal",
    jobType: "website_lookup",
    status: "processing",
    startedAt: new Date(),
    inputPayload: { jobId, totalRecords: 0 },
  }).returning();

  const prospectsResult = await storage.getProspects(job.listId!);
  const prospects = (prospectsResult as any).data ?? prospectsResult;
  const unenriched = (prospects as any[]).filter(p => !p.enrichedAt && p.status !== "do_not_contact");

  await db.update(enrichmentRuns).set({ inputPayload: { jobId, totalRecords: unenriched.length } }).where(eq(enrichmentRuns.id, enrichRun.id));

  let processed = 0;
  let failed = 0;

  for (const prospect of unenriched) {
    try {
      await enrichProspect(prospect.id);
      processed++;
    } catch (err) {
      console.error(`Enrichment failed for prospect ${prospect.id}:`, err);
      failed++;
    }

    await storage.updateEnrichmentJob(jobId, {
      processedCount: processed + failed,
      completedAt: undefined,
    });

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  await db.update(enrichmentRuns).set({
    status: failed > 0 ? "partial" : "success",
    completedAt: new Date(),
    outputPayload: { processed, failed, total: unenriched.length },
    errorMessage: failed > 0 ? `${failed} prospects failed enrichment` : null,
  }).where(eq(enrichmentRuns.id, enrichRun.id));

  await storage.updateEnrichmentJob(jobId, {
    status: failed > 0 ? "completed_with_errors" : "completed",
    processedCount: processed + failed,
    completedAt: new Date(),
    errorLog: failed > 0 ? `${failed} prospects failed enrichment` : undefined,
  });
}

export async function processEnrichmentQueue(): Promise<void> {
  const pendingJobs = await storage.getPendingEnrichmentJobs(1);
  if (pendingJobs.length === 0) return;

  const job = pendingJobs[0];
  await runEnrichmentJob(job.id);
}

let contactEnrichRunning = false;
export function isContactEnrichRunning() { return contactEnrichRunning; }

// Shared "field is missing" predicate for existing CRM contacts (task #1943).
// email/phone are NOT NULL columns (default ''), so "missing" means blank or
// a synthetic CSV-import placeholder, never SQL NULL for those two fields.
// This SQL fragment and contactFieldsMissing() below MUST stay in sync — the
// SQL selects candidates, the JS re-checks the same fields per-contact inside
// enrichContactBatch so a placeholder email is actually treated as missing
// (previously enrichContactBatch used a bare `!contact.email` check, which is
// truthy for placeholders and silently skipped replacing them forever).
const FIELD_MISSING_SQL = sql`(
  TRIM(email) = ''
  OR email ILIKE 'no-email-%'
  OR email ILIKE '%.internal'
  OR TRIM(phone) = ''
  OR website IS NULL
  OR TRIM(website) = ''
)`;

// Backlog contacts whose most recent Serper attempt (success or not) was within
// this window are skipped for the *automatic* selection query. Without this,
// a contact Serper can never fully resolve (e.g. business genuinely has no
// findable phone) would sit in the oldest-first page forever, get re-picked
// every recurring tick, burn quota, and permanently starve every contact
// behind it in the backlog.
const RECENT_ATTEMPT_COOLDOWN_SQL = sql`NOT EXISTS (
  SELECT 1 FROM enrichment_runs er
  WHERE er.contact_id = contacts.id
    AND er.provider = 'serper'
    AND er.job_type = 'email_lookup'
    AND er.started_at > now() - interval '24 hours'
)`;

// Shared eligible-population predicate — the ONLY definition of "in scope for
// enrichment" for contacts. Used verbatim by both the census/count query
// (getEnrichmentBacklogCount) and the execution/selection query
// (getContactIdsNeedingEnrichment) so the two can never drift. Excludes
// existing customers/merchants, archived records, DNC/do-not-auto-contact,
// lifecycle do-not-contact, test/demo/synthetic fixture rows, and DBPR
// lineage — none of these should have their identity enriched or flow toward
// paid providers / master_leads, even though enrichment itself never sends
// outbound contact.
export const CONTACT_ELIGIBLE_FOR_ENRICHMENT_SQL = sql`(
  archived_at IS NULL
  AND COALESCE(existing_merchant_customer, false) = false
  AND COALESCE(do_not_contact, false) = false
  AND COALESCE(do_not_auto_contact, false) = false
  AND COALESCE(lifecycle_stage, 'prospect') <> 'do_not_contact'
  AND COALESCE(record_class, 'unknown') NOT IN ('test', 'demo', 'synthetic')
  AND COALESCE(primary_source_type, '') NOT ILIKE '%dbpr%'
  AND COALESCE(primary_source_category, '') NOT ILIKE '%dbpr%'
)`;

const CONTACT_NEEDS_ENRICHMENT_SQL = sql`
  ${CONTACT_ELIGIBLE_FOR_ENRICHMENT_SQL}
  AND (COALESCE(TRIM(company_name), '') != '' OR COALESCE(TRIM(first_name), '') != '' OR COALESCE(TRIM(last_name), '') != '')
  AND ${FIELD_MISSING_SQL}
`;

/**
 * Normalizes a raw website/domain string (with or without protocol, path,
 * or "www.") down to a bare lowercase domain for comparison and crawling.
 * Returns null for blank/unusable input.
 */
function normalizeDomainString(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let v = raw.trim();
  if (!v) return null;
  v = v.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  v = v.split(/[\/?#]/)[0];
  v = v.toLowerCase();
  return v || null;
}

/**
 * Per-batch cache of first-party crawl results keyed by normalized domain,
 * so contacts that share a domain (e.g. multiple contacts at the same
 * business) trigger only one crawl per enrichContactBatch() call. Returns
 * whether this call actually triggered the crawl (cache miss) so callers can
 * attribute domain/page-attempt telemetry to the real outbound crawl only,
 * not to every contact that happens to read the cached result.
 */
function getOrCrawlDomain(
  cache: Map<string, Promise<ContactPageCrawlResult>>,
  domain: string
): { result: Promise<ContactPageCrawlResult>; wasNewCrawl: boolean } {
  const key = domain.toLowerCase();
  let entry = cache.get(key);
  let wasNewCrawl = false;
  if (!entry) {
    wasNewCrawl = true;
    entry = _crawlerDeps.crawlFirstPartyContactEmails(key).catch(
      () => ({ candidates: [], fetchCompleted: false, pagesAttempted: 0 })
    );
    cache.set(key, entry);
  }
  return { result: entry, wasNewCrawl };
}

/** Re-checks the same "missing" definition as CONTACT_NEEDS_ENRICHMENT_SQL for one contact. */
function contactFieldsMissing(contact: { email: string | null; phone: string; website: string | null }) {
  const email = contact.email ?? "";
  const emailMissing = email.trim() === "" || /^no-email-/i.test(email) || /\.internal$/i.test(email);
  const phoneMissing = (contact.phone ?? "").trim() === "";
  const websiteMissing = !contact.website || contact.website.trim() === "";
  return { emailMissing, phoneMissing, websiteMissing, anyMissing: emailMissing || phoneMissing || websiteMissing };
}

/**
 * Oldest-first page of existing contacts missing email, phone, or website,
 * excluding contacts attempted in the last 24h so the automatic recurring
 * tick keeps progressing through the backlog instead of retrying the same
 * unresolvable contacts every cycle. Manual admin batches that pass explicit
 * contactIds bypass this cooldown entirely (see POST /api/contacts/enrich-batch).
 */
export async function getContactIdsNeedingEnrichment(limit: number): Promise<number[]> {
  const result = await db.execute(sql`
    SELECT id FROM contacts
    WHERE ${CONTACT_NEEDS_ENRICHMENT_SQL}
      AND ${RECENT_ATTEMPT_COOLDOWN_SQL}
    ORDER BY id ASC
    LIMIT ${limit}
  `);
  return (result.rows as any[]).map(r => Number(r.id));
}

/** Total remaining backlog size for the Enrichment Activation Panel. */
export async function getEnrichmentBacklogCount(): Promise<number> {
  const result = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM contacts WHERE ${CONTACT_NEEDS_ENRICHMENT_SQL}
  `);
  return Number((result.rows[0] as any)?.n ?? 0);
}

export async function enrichContactBatch(
  contactIds: number[],
  options?: { batchSize?: number }
): Promise<{
  processed: number;
  emailsFound: number;
  phonesFound: number;
  websitesFound: number;
  errors: number;
  gatewayBlocked: boolean;
  // task #1977/#1978 telemetry — counts and source classification only,
  // never raw emails.
  //
  // serperEmailsFound counts emails Serper found AND actually wrote to
  // contacts.email; totalEmailsFound === emailsFound === serperEmailsFound
  // today (an explicit alias kept so callers don't have to infer that the
  // two Serper sources roll into the same pre-existing counter).
  //
  // crawlerEmailsFound is DIFFERENT in kind, not just a third source added
  // to the same total: per Task #1978 correction #3, a crawler-discovered
  // address is never written to contacts.email — it's staged as encrypted
  // free-discovery candidate evidence instead (see
  // server/services/free-discovery/evidence-service.ts). crawlerEmailsFound
  // counts candidates staged this way; it does NOT roll into
  // emailsFound/totalEmailsFound, and no email address it counts was ever
  // written to a contact record by this function.
  crawlerDomainsAttempted: number;
  crawlerPagesAttempted: number;
  crawlerEmailsFound: number;
  crawlerAmbiguous: number;
  serperEmailsFound: number;
  totalEmailsFound: number;
}> {
  if (contactEnrichRunning) {
    console.warn("[ContactEnrich] Already running, skipping.");
    return {
      processed: 0, emailsFound: 0, phonesFound: 0, websitesFound: 0, errors: 0, gatewayBlocked: false,
      crawlerDomainsAttempted: 0, crawlerPagesAttempted: 0, crawlerEmailsFound: 0, crawlerAmbiguous: 0,
      serperEmailsFound: 0, totalEmailsFound: 0,
    };
  }
  contactEnrichRunning = true;
  const batchSize = options?.batchSize || 10;
  let processed = 0;
  let emailsFound = 0;
  let phonesFound = 0;
  let websitesFound = 0;
  let errors = 0;
  let gatewayBlocked = false;
  let crawlerDomainsAttempted = 0;
  let crawlerPagesAttempted = 0;
  let crawlerEmailsFound = 0;
  let crawlerAmbiguous = 0;
  let serperEmailsFound = 0;
  // Scoped to this single batch call — contacts sharing a domain (e.g. two
  // contacts at the same business) trigger only one crawl.
  const crawlCache = new Map<string, Promise<ContactPageCrawlResult>>();
  // Lazily created once per batch call, the first time the crawler actually
  // yields a selectable candidate — a batch that never reaches the crawler
  // (Serper-only outcomes) never opens a free-discovery generation.
  // Contacts in a batch are processed concurrently, so this must memoize a
  // single in-flight PROMISE (not a resolved value) — otherwise two contacts
  // can both observe a null id at the same time and each create their own
  // generation row, silently splitting one batch's candidates across two
  // generations (only one of which ever gets completed/counted at batch end).
  let batchFreeDiscoveryGenerationPromise: Promise<string> | null = null;
  async function getOrCreateBatchFreeDiscoveryGenerationId(): Promise<string> {
    if (!batchFreeDiscoveryGenerationPromise) {
      batchFreeDiscoveryGenerationPromise = createFreeDiscoveryGeneration({
        runKey: newFreeDiscoveryRunKey("contact_enrich_batch"),
        actorId: "system:contact_enrich_batch",
        reason: "Task #1977/#1978 first-party contact-page crawl candidate capture",
      }).then((gen) => gen.id);
    }
    return batchFreeDiscoveryGenerationPromise;
  }
  // Only contacts that were actually, successfully processed this batch are
  // eligible for downstream business materialization — never contacts that
  // were skipped (missing name), blocked mid-call, or never attempted
  // because an earlier contact tripped the gateway.
  const materializableContactIds: number[] = [];

  const progressKey = "contact_enrich_batch_progress";

  try {
    const [enrichRun] = await db.insert(enrichmentRuns).values({
      provider: "serper",
      jobType: "email_lookup",
      status: "processing",
      startedAt: new Date(),
      inputPayload: { totalRecords: contactIds.length, contactIds: contactIds.slice(0, 10) },
    }).returning();

    await storage.setSystemSetting(progressKey, {
      status: "running",
      total: contactIds.length,
      processed: 0,
      emailsFound: 0,
      phonesFound: 0,
      websitesFound: 0,
      errors: 0,
      startedAt: new Date().toISOString(),
      enrichmentRunId: enrichRun.id,
    });

    batchLoop:
    for (let i = 0; i < contactIds.length; i += batchSize) {
      const batch = contactIds.slice(i, i + batchSize);

      for (const contactId of batch) {
        try {
          const contact = await storage.getContact(contactId);
          if (!contact) { errors++; continue; }

          const companyName = contact.companyName || `${contact.firstName || ""} ${contact.lastName || ""}`.trim();
          if (!companyName) { errors++; continue; }

          const missing = contactFieldsMissing(contact);
          const needsEmail = missing.emailMissing;
          const needsPhone = missing.phoneMissing;
          const needsWebsite = missing.websiteMissing;
          const needsSerper = missing.anyMissing;

          const updates: Record<string, any> = {};
          let serperAttempted = false;
          // Per-contact classification tag for batch telemetry only — never
          // exposed to unrestricted logs/telemetry as a raw email, just this
          // enum. See enrichContactBatch's return type for the aggregate counts.
          let emailDiscoverySource: "serper_primary" | "serper_email_search" | "first_party_contact_page" | null = null;
          // Set when a call's own outcome (not the cheap pre-filter) proves
          // the gateway blocked mid-batch. We still finish writing back
          // whatever this contact's earlier, genuinely-completed call found
          // (e.g. website resolved before the follow-up email lookup got
          // blocked) — losing real data because a LATER call failed would be
          // its own bug — but stop attempting any further contacts.
          let stopBatchAfterThisContact = false;
          // True when this contact's crawl produced a staged free-discovery
          // candidate (role or named) rather than nothing at all — used so
          // the enrichment_runs audit row says "candidate staged", not the
          // misleading "no_match", when we genuinely found something and
          // simply didn't write it straight to contacts.email (correction #3).
          let crawlerCandidateStaged = false;
          // Distinct from stopBatchAfterThisContact: a first-party crawl
          // failure (DNS/TLS/timeout fetching ONE business's own website) is
          // domain-specific, not a signal that the shared Serper gateway or
          // the crawler transport is down for everyone. It must not stop the
          // batch or mark it gateway-blocked — only skip recording a
          // cooldown row for THIS contact so it retries promptly, while
          // every other queued contact still gets processed this run.
          let crawlTransportFailedNoCooldown = false;

          if (needsSerper) {
            if (!isSerperConfigured()) {
              errors++;
              continue;
            }

            // Cheap pre-filter only — NOT the source of truth. Circuit state
            // and enabled don't cover every way the gateway can block a call
            // (budget exhaustion, malformed/unreadable control, rollover
            // failure, half-open probe contention, or a trip that happens
            // during the request itself). This just avoids a doomed attempt
            // when we already know the answer.
            const control = await serperGateway.getControl();
            if (!control?.enabled || control.state === "open") {
              console.warn(`[ContactEnrich] Gateway pre-filter blocked (enabled=${control?.enabled}, state=${control?.state}) — stopping batch early.`);
              gatewayBlocked = true;
              break batchLoop;
            }

            const serperResult = await _serperDeps.searchBusiness(companyName, contact.city || undefined, contact.state || "FL");

            if (!serperResult.providerAttempted) {
              // The gateway blocked/failed this specific call (budget just
              // exhausted, circuit tripped mid-request, malformed control,
              // etc). `serperResult` is empty here for the SAME reason a
              // genuine no-match is empty, so this check is the only
              // reliable signal — do NOT fall through to the no_match/
              // cooldown path below on this outcome. Nothing was found for
              // this contact, so stop the batch immediately; the contact
              // stays fully eligible (no cooldown row) for the very next run.
              console.warn(`[ContactEnrich] Serper call did not complete for contact ${contactId} — stopping batch early, no cooldown recorded.`);
              gatewayBlocked = true;
              break batchLoop;
            }

            serperAttempted = true;

            if (serperResult.website && needsWebsite) {
              updates.website = serperResult.website;
              websitesFound++;
            }
            if (serperResult.emails.length > 0 && needsEmail) {
              updates.email = serperResult.emails[0];
              emailsFound++;
              serperEmailsFound++;
              emailDiscoverySource = "serper_primary";
            }
            if (serperResult.phones.length > 0 && needsPhone) {
              updates.phone = serperResult.phones[0];
              phonesFound++;
            }

            if (needsEmail && !updates.email) {
              // Resolve the best known domain in priority order so an
              // already-known contact or canonical-business domain is never
              // lost just because THIS Serper attempt found no website:
              // (1) the contact's own existing website, (2) the linked
              // business's canonical website_domain, (3) the website this
              // searchBusiness() call just found.
              let bestKnownDomain = normalizeDomainString(contact.website);
              if (!bestKnownDomain && contact.businessId) {
                const [linkedBusiness] = await db
                  .select({ websiteDomain: businesses.websiteDomain })
                  .from(businesses)
                  .where(eq(businesses.id, contact.businessId))
                  .limit(1);
                bestKnownDomain = normalizeDomainString(linkedBusiness?.websiteDomain ?? null);
              }
              if (!bestKnownDomain) {
                bestKnownDomain = normalizeDomainString(serperResult.website);
              }

              if (bestKnownDomain) {
                const emailResult = await _serperDeps.searchBusinessEmail(companyName, bestKnownDomain, contact.city || undefined);
                if (!emailResult.providerAttempted) {
                  console.warn(`[ContactEnrich] Serper email-lookup call did not complete for contact ${contactId} — finishing this contact with what was already found, then stopping batch.`);
                  stopBatchAfterThisContact = true;
                } else if (emailResult.emails.length > 0) {
                  updates.email = emailResult.emails[0];
                  emailsFound++;
                  serperEmailsFound++;
                  emailDiscoverySource = "serper_email_search";
                }
              }

              // No new Serper call here — only the shared, SSRF-safe
              // first-party crawler (server/services/sdr/contactpage-enrichment.ts),
              // bounded to a fixed page set and an overall deadline, and only
              // when the two Serper steps above genuinely completed and
              // still found nothing.
              if (!stopBatchAfterThisContact && !updates.email && bestKnownDomain) {
                // Task #1978 correction #4: a fresh domain-cache entry for this
                // domain is reused without recrawling — including a fresh
                // NEGATIVE result (crawled recently, found no role email),
                // which must also skip recrawling. Cache reads never return
                // named (non-role) addresses — those are never cached.
                const domainCache = await getDomainCache(bestKnownDomain).catch(() => ({ fresh: false, emails: [] as { email: string; confidence: number }[] }));
                let selection: { email: string | null; sourceUrl: string | null; confidence: number; ambiguous: boolean };
                let crawledThisContact = false;
                let crawlGenuinelyCompletedEmpty = false;
                // True only when THIS contact's lookup performed a genuine
                // outbound crawl (not a cache hit, and not a reader riding an
                // earlier contact's in-flight crawl in this same batch).
                // Domain-cache metadata (last_crawled_at/crawl_count/TTL) must
                // only ever advance on this path — otherwise merely reading a
                // cached role address re-stages it into a new generation
                // (recordFreeDiscoveryCandidate always inserts fresh per
                // generation) and that insert's cache-touch would refresh the
                // TTL and crawl_count for a crawl that never actually happened,
                // letting a frequently-read domain's stale evidence survive
                // indefinitely without ever being re-verified.
                let originatedFromLiveCrawl = false;
                if (domainCache.fresh && domainCache.emails.length === 1) {
                  selection = { email: domainCache.emails[0].email, sourceUrl: null, confidence: domainCache.emails[0].confidence, ambiguous: false };
                } else if (domainCache.fresh && domainCache.emails.length > 1) {
                  selection = { email: null, sourceUrl: null, confidence: 0, ambiguous: true };
                } else if (domainCache.fresh) {
                  // Fresh cache row with zero role emails — an authoritative
                  // negative result from an earlier crawl in the TTL window.
                  // Nothing to do; do NOT recrawl.
                  selection = { email: null, sourceUrl: null, confidence: 0, ambiguous: false };
                } else {
                  crawledThisContact = true;
                  const { result: crawlResultPromise, wasNewCrawl } = getOrCrawlDomain(crawlCache, bestKnownDomain);
                  const crawlResult = await crawlResultPromise;
                  // Only attribute domain/page-attempt telemetry to the actual
                  // outbound crawl (cache miss) — a contact that merely reads a
                  // cached result from an earlier contact in this batch didn't
                  // trigger a second crawl.
                  if (wasNewCrawl) {
                    crawlerDomainsAttempted++;
                    crawlerPagesAttempted += crawlResult.pagesAttempted;
                  }
                  if (!crawlResult.fetchCompleted) {
                    // Transport failure (timeout, DNS failure, thrown exception)
                    // — NOT an SSRF block, which reports fetchCompleted:true as
                    // a valid skip. This lookup never genuinely completed for
                    // THIS contact's domain, so don't record a cooldown row —
                    // it stays immediately eligible for retry. But this is
                    // domain-specific, not a shared-gateway problem, so it must
                    // NOT stop the rest of the batch the way a real Serper
                    // gateway block does.
                    console.warn(`[ContactEnrich] First-party crawl did not complete for contact ${contactId} (domain=${bestKnownDomain}) — leaving this contact eligible for retry, continuing batch.`);
                    crawlTransportFailedNoCooldown = true;
                    selection = { email: null, sourceUrl: null, confidence: 0, ambiguous: false };
                  } else if (wasNewCrawl) {
                    // The contact that actually triggered this crawl may claim
                    // ANY candidate the crawl found — role or named — since it
                    // is the one contact whose lookup genuinely produced this
                    // evidence.
                    originatedFromLiveCrawl = true;
                    selection = selectContactDiscoveryEmail(crawlResult.candidates, bestKnownDomain);
                    crawlGenuinelyCompletedEmpty = !selection.email && !selection.ambiguous;
                  } else {
                    // Correction #4 (in-batch leak fix): a contact that merely
                    // reads an in-flight/completed crawl result from an EARLIER
                    // contact in this same batch (via crawlCache) must never be
                    // able to independently "select" a named/person address out
                    // of it — that would attribute the same person's address to
                    // a second, different contact. Such a reader may only ever
                    // pick up an already role-classified candidate; a named
                    // candidate is invisible to it, exactly as if it weren't
                    // there.
                    const roleOnlyCandidates = crawlResult.candidates.filter((c) => isRoleInboxEmail(c.email));
                    selection = selectContactDiscoveryEmail(roleOnlyCandidates, bestKnownDomain);
                    crawlGenuinelyCompletedEmpty = !selection.email && !selection.ambiguous;
                  }
                }

                if (!crawlTransportFailedNoCooldown) {
                  if (selection.ambiguous) {
                    crawlerAmbiguous++;
                  } else if (selection.email) {
                    // Task #1978 correction #3: a newly-discovered, unvalidated
                    // address is NEVER written to contacts.email directly. It is
                    // persisted as encrypted candidate evidence instead, and
                    // only the governed validation/projection path may later
                    // fill an operational email field.
                    //
                    // Correction #4: only a genuine role/shared inbox
                    // (info@/sales@/etc) is business-scoped and cache-eligible.
                    // Any other address is scoped to THIS contact only and is
                    // never written to the domain cache, so it can never leak
                    // onto a different contact at the same business.
                    const isRole = isRoleInboxEmail(selection.email);
                    // A role address is business-scoped when a business link
                    // exists; otherwise it still needs *some* owning subject,
                    // so it falls back to this contact rather than being
                    // recorded as an orphaned business_id=null/contact_id=null
                    // row. It keeps attributionScope:"role" (and is still
                    // written into the domain cache below) either way — the
                    // scope FK is about audit ownership, not about whether the
                    // address itself is a shared role inbox.
                    const roleHasBusinessLink = isRole && !!contact.businessId;
                    try {
                      const generationId = await getOrCreateBatchFreeDiscoveryGenerationId();
                      await recordFreeDiscoveryCandidate({
                        generationId,
                        // A role/shared inbox is business-level evidence
                        // regardless of whether a businesses row is already
                        // linked (it falls back to contactId ownership below
                        // only for FK bookkeeping, never changing what kind of
                        // evidence it is). A named/person address is always
                        // person-level evidence, tied to the one contact it
                        // was found for — never eligible for business-email
                        // projection.
                        subjectType: isRole ? "business" : "person",
                        businessId: roleHasBusinessLink ? contact.businessId! : null,
                        contactId: roleHasBusinessLink ? null : contactId,
                        domain: bestKnownDomain,
                        email: selection.email,
                        source: "first_party_contact_page",
                        attributionScope: isRole ? "role" : "named",
                        confidence: selection.confidence,
                        // Only a genuine outbound crawl this contact actually
                        // performed may advance the domain cache's crawl
                        // metadata/TTL — never a cache hit or an in-batch
                        // cache read, or a frequently-read domain's stale
                        // evidence would never expire.
                        refreshDomainCache: originatedFromLiveCrawl,
                      });
                      crawlerEmailsFound++;
                      crawlerCandidateStaged = true;
                    } catch (candidateErr) {
                      console.error(`[ContactEnrich] Failed to record free-discovery candidate for contact ${contactId}:`, candidateErr);
                    }
                  } else if (crawledThisContact && crawlGenuinelyCompletedEmpty) {
                    // A genuinely completed crawl that found nothing usable —
                    // cache that outcome too, so this domain isn't recrawled
                    // by every contact sharing it until the cache TTL expires.
                    try {
                      const generationId = await getOrCreateBatchFreeDiscoveryGenerationId();
                      await markDomainCrawled(bestKnownDomain, generationId);
                    } catch (cacheErr) {
                      console.error(`[ContactEnrich] Failed to record empty-crawl domain cache entry for ${bestKnownDomain}:`, cacheErr);
                    }
                  }
                }
              }
            }
          }

          const currentTitle = contact.title ?? null;
          if (currentTitle && contact.businessId) {
            const dm = scoreDecisionMaker(currentTitle);
            await recordDecisionMakerCandidate({
              contactId, businessId: contact.businessId, source: "title_heuristic",
              sourceVersion: "bounce-feedback-v1", confidence: dm.confidence,
            });
          }

          const foundSomething = Object.keys(updates).length > 0;

          // Persist any real data found BEFORE the block happened regardless
          // of stopBatchAfterThisContact — a later step being blocked must
          // never cause us to discard an earlier step's genuine result.
          if (foundSomething) {
            if (updates.email || updates.phone) {
              // Keep this in the canonical writer transaction so active
              // CRO-03B recipe contacts cannot be mutated by a legacy worker.
              updates.outreachQueueSkippedAt = null;
            }
            await updateContactLocalFirst(contactId, updates);
            enqueueReadinessRecalculation(contactId).catch(() => {});
          }

          // The enrichment_runs row is what getContactIdsNeedingEnrichment's
          // cooldown keys off of — it must ONLY be written when every lookup
          // this contact needed actually completed. If a later step (e.g.
          // the email search after a website was already found) was blocked,
          // the contact is still genuinely missing that field and must stay
          // immediately eligible, even though we already wrote the website
          // we did resolve. Writing a "success" row here just because SOME
          // field was found would wrongly suppress retrying the missing one.
          if (!stopBatchAfterThisContact && !crawlTransportFailedNoCooldown) {
            if (foundSomething) {
              try {
                await db.insert(enrichmentRuns).values({
                  provider: "serper",
                  jobType: "email_lookup",
                  status: "success",
                  contactId,
                  businessId: contact.businessId || null,
                  startedAt: new Date(),
                  completedAt: new Date(),
                  outputPayload: emailDiscoverySource ? { ...updates, emailDiscoverySource } : updates,
                });
              } catch (_) {}
              processed++;
              materializableContactIds.push(contactId);
            } else if (serperAttempted) {
              // Serper completed every lookup it needed to. Record the
              // attempt so getContactIdsNeedingEnrichment's cooldown skips
              // this contact for 24h instead of retrying it — and starving
              // everything behind it in the backlog — every tick. Use a
              // distinct status when a free-discovery candidate WAS staged
              // (Task #1978 correction #3 — found, but never written to
              // contacts.email) so this audit row doesn't misreport a real
              // find as "no_match".
              try {
                await db.insert(enrichmentRuns).values({
                  provider: "serper",
                  jobType: "email_lookup",
                  status: crawlerCandidateStaged ? "candidate_staged" : "no_match",
                  contactId,
                  businessId: contact.businessId || null,
                  startedAt: new Date(),
                  completedAt: new Date(),
                  outputPayload: crawlerCandidateStaged ? { emailDiscoverySource: "first_party_contact_page" } : {},
                });
              } catch (_) {}
              processed++;
              materializableContactIds.push(contactId);
            }
            // else: this contact didn't need Serper at all — nothing to record.
          }
          // else (stopBatchAfterThisContact or crawlTransportFailedNoCooldown):
          // no enrichment_runs row is written here on purpose — the contact
          // remains immediately eligible (no false cooldown) for its
          // still-missing field(s) on the next run.

          if (stopBatchAfterThisContact) {
            // A real shared-gateway signal (Serper call itself didn't
            // complete) — every other queued contact would hit the same
            // wall, so stop the whole batch rather than burn through it.
            gatewayBlocked = true;
            break batchLoop;
          }
          // crawlTransportFailedNoCooldown intentionally does NOT set
          // gatewayBlocked or break the loop — it's specific to this one
          // contact's domain, not the shared Serper/crawler transport, so
          // every other queued contact must still get processed this run.
        } catch (err) {
          console.error(`[ContactEnrich] Error enriching contact ${contactId}:`, err);
          errors++;
        }

        await new Promise(r => setTimeout(r, 200));
      }

      await storage.setSystemSetting(progressKey, {
        status: "running",
        total: contactIds.length,
        processed,
        emailsFound,
        phonesFound,
        websitesFound,
        errors,
        completed: processed + errors,
        gatewayBlocked,
        lastUpdate: new Date().toISOString(),
      });
    }

    await storage.setSystemSetting(progressKey, {
      // "blocked" instead of "complete" when the gateway tripped mid-batch —
      // the remaining contacts were never attempted and stay fully eligible
      // for the next run, so this must read differently from a clean finish.
      status: gatewayBlocked ? "blocked" : "complete",
      total: contactIds.length,
      processed,
      emailsFound,
      phonesFound,
      websitesFound,
      errors,
      completed: processed + errors,
      gatewayBlocked,
      completedAt: new Date().toISOString(),
    });

    await db.update(enrichmentRuns).set({
      status: gatewayBlocked ? "partial" : errors > 0 ? "partial" : "success",
      completedAt: new Date(),
      outputPayload: {
        processed, errors, emailsFound, phonesFound, websitesFound, gatewayBlocked,
        crawlerDomainsAttempted, crawlerPagesAttempted, crawlerEmailsFound, crawlerAmbiguous, serperEmailsFound,
      },
      errorMessage: gatewayBlocked
        ? "Serper gateway blocked (disabled or circuit open) — batch stopped early"
        : errors > 0 ? `${errors} contacts failed enrichment` : null,
    }).where(eq(enrichmentRuns.id, enrichRun.id));

    for (const cid of materializableContactIds) {
      try {
        await ingestBusinessFromContact(cid, "serper", `contact_enrich_batch`);
      } catch (err) {
        console.error(`[ContactEnrich] Business materialization failed for contact ${cid}:`, err);
      }
    }

    if (batchFreeDiscoveryGenerationPromise) {
      try {
        await completeFreeDiscoveryGeneration(await batchFreeDiscoveryGenerationPromise);
      } catch (err) {
        console.error("[ContactEnrich] Failed to close free-discovery generation:", err);
      }
    }
  } catch (fatalErr) {
    console.error("[ContactEnrich] Fatal error in batch enrichment:", fatalErr);
    await storage.setSystemSetting(progressKey, {
      status: "failed",
      total: contactIds.length,
      processed,
      emailsFound,
      phonesFound,
      websitesFound,
      errors,
      error: String(fatalErr),
      failedAt: new Date().toISOString(),
    }).catch(() => {});
  } finally {
    contactEnrichRunning = false;
  }

  return {
    processed, emailsFound, phonesFound, websitesFound, errors, gatewayBlocked,
    crawlerDomainsAttempted, crawlerPagesAttempted, crawlerEmailsFound, crawlerAmbiguous,
    serperEmailsFound, totalEmailsFound: emailsFound,
  };
}
