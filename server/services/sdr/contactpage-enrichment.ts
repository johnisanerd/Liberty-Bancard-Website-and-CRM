import { db } from "../../db";
import { sdrMerchants, sdrMerchantContacts } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { isSafeFetchTarget } from "./url-safety";

const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const NON_OWNER_PREFIXES = ["noreply", "no-reply", "info", "support", "help", "admin", "contact",
  "hello", "hi", "sales", "team", "service", "donotreply", "notifications", "billing",
  "newsletter", "marketing", "webmaster", "postmaster"];

function isOwnerLikeEmail(email: string): boolean {
  const local = email.split("@")[0].toLowerCase();
  return !NON_OWNER_PREFIXES.some(p => local === p || local.startsWith(p + ".") || local.startsWith(p + "+"));
}

function extractEmailsFromHtml(html: string): string[] {
  const found = new Set<string>();
  const mailtoMatches = html.matchAll(/href=["']mailto:([^"'?\s]+)/gi);
  for (const m of mailtoMatches) {
    const email = m[1].trim().toLowerCase();
    if (email.includes("@") && isOwnerLikeEmail(email)) found.add(email);
  }
  const regexMatches = html.matchAll(EMAIL_REGEX);
  for (const m of regexMatches) {
    const email = m[0].toLowerCase();
    if (isOwnerLikeEmail(email)) found.add(email);
  }
  return Array.from(found);
}

async function fetchPageHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; LibertyBancardBot/1.0)" },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

const CONTACT_PATHS = ["/contact", "/about", "/team", "/staff", "/contact-us", "/about-us"];
const RATE_LIMIT_MS = 500;

async function findEmailOnSite(baseUrl: string): Promise<string | null> {
  let base = baseUrl;
  if (!base.startsWith("http")) base = `https://${base}`;
  base = base.replace(/\/$/, "");

  for (const path of CONTACT_PATHS) {
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
    const html = await fetchPageHtml(`${base}${path}`);
    if (!html) continue;
    const emails = extractEmailsFromHtml(html);
    if (emails.length > 0) return emails[0];
  }

  const homeHtml = await fetchPageHtml(base);
  if (homeHtml) {
    const emails = extractEmailsFromHtml(homeHtml);
    if (emails.length > 0) return emails[0];
  }

  return null;
}

export async function runContactPageEnrichment(merchantId: number): Promise<{ enriched: boolean; source: "contactpage" }> {
  const [merchant] = await db.select().from(sdrMerchants).where(eq(sdrMerchants.id, merchantId));
  if (!merchant?.website && !merchant?.domain) return { enriched: false, source: "contactpage" };

  const siteUrl = merchant.website || merchant.domain!;
  const normalizedUrl = siteUrl.startsWith("http") ? siteUrl : `https://${siteUrl}`;
  const safe = await isSafeFetchTarget(normalizedUrl);
  if (!safe) {
    console.info(`[ContactPage] Blocked unsafe URL for merchant ${merchantId}: ${siteUrl}`);
    return { enriched: false, source: "contactpage" };
  }
  const email = await findEmailOnSite(siteUrl);
  if (!email) return { enriched: false, source: "contactpage" };

  await db.insert(sdrMerchantContacts).values({
    merchantId,
    contactName: null,
    email,
    roleGuess: "owner",
    emailConfidence: 70,
    primaryContactFlag: false,
  } as any);

  return { enriched: true, source: "contactpage" };
}

export async function runContactPageEnrichmentBatch(limit = 50): Promise<{ processed: number; enriched: number }> {
  const merchants = await db
    .select({ id: sdrMerchants.id })
    .from(sdrMerchants)
    .where(
      and(
        sql`(${sdrMerchants.domain} IS NOT NULL OR ${sdrMerchants.website} IS NOT NULL)`,
        sql`${sdrMerchants.ownerEnrichmentStatus} = 'pending'`,
        sql`${sdrMerchants.doNotContactFlag} IS NOT TRUE`,
        sql`NOT EXISTS (SELECT 1 FROM sdr_merchant_contacts mc WHERE mc.merchant_id = ${sdrMerchants.id} AND mc.email IS NOT NULL)`,
      )
    )
    .limit(limit);

  let processed = 0;
  let enriched = 0;
  for (const m of merchants) {
    try {
      const res = await runContactPageEnrichment(m.id);
      processed++;
      if (res.enriched) enriched++;
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`[ContactPage] Error enriching merchant ${m.id}:`, err);
      processed++;
    }
  }
  console.log(`[ContactPage] Batch done: ${processed} processed, ${enriched} enriched`);
  return { processed, enriched };
}

export async function getOwnerEmailCoverage(): Promise<{
  totalMerchants: number;
  merchantsWithEmail: number;
  coveragePct: number;
}> {
  const [total] = await db
    .select({ count: sql<number>`count(*)` })
    .from(sdrMerchants);
  const [withEmail] = await db
    .select({ count: sql<number>`count(distinct merchant_id)` })
    .from(sdrMerchantContacts)
    .where(sql`email IS NOT NULL`);

  const totalMerchants = Number(total?.count || 0);
  const merchantsWithEmail = Number(withEmail?.count || 0);
  const coveragePct = totalMerchants > 0
    ? Math.round((merchantsWithEmail / totalMerchants) * 100)
    : 0;

  return { totalMerchants, merchantsWithEmail, coveragePct };
}

/**
 * Business-scoped contact-page enrichment — MI-04 free enrichment path.
 *
 * Accepts a businessId + domain. Returns actual discovered email addresses
 * (not just a count) so callers can persist them as encrypted
 * free_discovery_candidates. Never writes sdr_merchant_contacts rows.
 *
 * Correction #1: emails[] is the source of truth; emailCount and enriched are
 * retained for backwards-compat. The caller (runFreeBusinessEnrichmentForBusiness)
 * is responsible for domain-cache integration and candidate persistence.
 */
export interface ContactPageBusinessResult {
  emailCount: number;
  enriched: boolean;
  /** Actual email addresses found — each entry is a candidate for the business. */
  emails: string[];
  /** true when at least one page fetch completed (even with no emails); false if root domain fetch failed */
  fetchCompleted: boolean;
}

export async function runContactPageBusinessEnrichment(
  businessId: number,
  domain: string
): Promise<ContactPageBusinessResult> {
  const { isSafeFetchTarget } = await import("./url-safety");
  const { safeFetch } = await import("./safe-fetch");

  const baseUrl = domain.startsWith("http") ? domain : `https://${domain}`;
  const baseUrlObj = (() => {
    try { return new URL(baseUrl); } catch { return null; }
  })();
  if (!baseUrlObj) return { emailCount: 0, enriched: false, emails: [], fetchCompleted: false };

  // SSRF check on the root domain before attempting any page
  const safe = await isSafeFetchTarget(baseUrl);
  if (!safe) {
    console.info(`[ContactPage-Business] SSRF blocked domain for business ${businessId}: ${domain}`);
    // SSRF block is a valid skip — not a transient transport failure.
    return { emailCount: 0, enriched: false, emails: [], fetchCompleted: true };
  }

  const emailSet = new Set<string>();
  const urlsToTry = [
    baseUrl,
    ...CONTACT_PATHS.map(p => baseUrlObj.origin + p),
  ];

  // Track whether the root-domain fetch completed. Sub-pages are best-effort.
  let rootFetchCompleted = false;

  for (const url of urlsToTry) {
    try {
      // Use safeFetch: enforces redirect validation + size cap + SSRF re-check per redirect
      const resp = await safeFetch(url, { timeoutMs: 10000 });
      if (url === baseUrl) {
        // null = transport failure (timeout/DNS/SSRF block); non-null = fetch completed
        rootFetchCompleted = resp !== null;
      }
      if (resp?.ok) {
        // body is eagerly read by safeFetch — no separate async read needed
        const html = resp.body ?? "";
        const emails = extractEmailsFromHtml(html);
        for (const e of emails) emailSet.add(e);
        if (emailSet.size > 0 && url !== baseUrl) break; // found on a contact page
      }
      if (url !== baseUrl) {
        await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
      }
    } catch {
      // non-fatal: proceed to next page
    }
  }

  const emails = Array.from(emailSet);
  const emailCount = emails.length;
  console.log(`[ContactPage-Business] Business ${businessId}: emailCount=${emailCount}, rootFetchCompleted=${rootFetchCompleted}`);
  return { emailCount, enriched: emailCount > 0, emails, fetchCompleted: rootFetchCompleted };
}

/**
 * Shared first-party contact-page crawler — task #1977.
 *
 * Reused by contact-level email discovery (server/services/enrichment.ts)
 * when Serper's business/email search finds nothing. Deliberately separate
 * from findEmailOnSite()/runContactPageBusinessEnrichment() above: those
 * paths must keep their exact existing behavior (owner-only email policy for
 * sdr_merchants, count-only contract for the business lane). This function
 * returns raw candidate emails with evidence so callers apply their own
 * acceptance policy — see selectContactDiscoveryEmail() below for the
 * contact-discovery policy.
 *
 * Bounded by design: a fixed small path list (never arbitrary link
 * traversal), a hard per-crawl page cap, and an overall wall-clock deadline
 * so a slow or unresponsive site can never dominate a recurring batch.
 */
export interface ContactPageCrawlCandidate {
  email: string;
  sourceUrl: string;
  evidenceType: "mailto" | "visible_text";
}

export interface ContactPageCrawlResult {
  candidates: ContactPageCrawlCandidate[];
  /** true once the root-domain fetch completed (even with zero candidates); false on transport failure/SSRF block before any page was reachable. */
  fetchCompleted: boolean;
  pagesAttempted: number;
}

const CRAWL_MAX_PAGES = 4;
const CRAWL_PAGE_TIMEOUT_MS = 8_000;
const CRAWL_OVERALL_DEADLINE_MS = 20_000;
// Trimmed subset of CONTACT_PATHS above — bounded page count is the point,
// so we keep only the highest-yield paths rather than trying all six.
const PRIORITY_CRAWL_PATHS = ["/contact", "/contact-us", "/about", "/about-us"];

const ASSET_TLDS = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "webp", "css", "js", "ico", "woff", "woff2", "ttf", "eot", "map",
]);
const JUNK_LOCAL_PREFIXES = [
  "noreply", "no-reply", "donotreply", "do-not-reply", "postmaster", "webmaster", "mailer-daemon", "abuse",
];
const SKIP_EMAIL_DOMAINS = new Set([
  "example.com", "test.com", "sentry.io", "wixpress.com", "w3.org", "schema.org",
  "googleapis.com", "google.com", "facebook.com", "godaddy.com", "wordpress.com",
  "placeholder.com", "domain.com", "yourdomain.com", "email.com", "sentry-next.wixpress.com",
]);
const EMAIL_STRICT_REGEX = /^[a-z0-9](?:[a-z0-9._%+-]*[a-z0-9])?@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i;

/**
 * Base sanity filter shared by every consumer of the crawler's raw output:
 * rejects malformed addresses, noreply/postmaster-style mailer addresses,
 * synthetic "no-email-*"/".internal" placeholders (see the contacts backlog
 * placeholder convention in enrichment.ts), known non-business/example
 * domains, and CSS/JS asset false positives (e.g. "photo@2x.png" scraped out
 * of a `background-image: url(...)` rule). This is NOT the full acceptance
 * policy for any one consumer — see isOwnerLikeEmail() (legacy, owner-only)
 * and selectContactDiscoveryEmail() (new, role-inbox-friendly) for those.
 */
function isJunkCandidateEmail(email: string): boolean {
  if (!EMAIL_STRICT_REGEX.test(email)) return true;
  const at = email.indexOf("@");
  const local = email.slice(0, at).toLowerCase();
  const domain = email.slice(at + 1).toLowerCase();
  const tld = domain.split(".").pop() || "";
  if (ASSET_TLDS.has(tld)) return true;
  if (JUNK_LOCAL_PREFIXES.some(p => local === p || local.startsWith(p + ".") || local.startsWith(p + "+"))) return true;
  if (/^no-email-/.test(local) || domain.endsWith(".internal")) return true;
  if (SKIP_EMAIL_DOMAINS.has(domain)) return true;
  return false;
}

export function extractCandidatesFromPage(html: string, sourceUrl: string): ContactPageCrawlCandidate[] {
  const byEmail = new Map<string, "mailto" | "visible_text">();
  const mailtoMatches = html.matchAll(/href=["']mailto:([^"'?\s]+)/gi);
  for (const m of mailtoMatches) {
    const email = m[1].trim().toLowerCase();
    if (!isJunkCandidateEmail(email)) byEmail.set(email, "mailto");
  }
  const regexMatches = html.matchAll(EMAIL_REGEX);
  for (const m of regexMatches) {
    const email = m[0].toLowerCase();
    if (isJunkCandidateEmail(email)) continue;
    if (!byEmail.has(email)) byEmail.set(email, "visible_text");
  }
  return Array.from(byEmail.entries()).map(([email, evidenceType]) => ({ email, evidenceType, sourceUrl }));
}

export async function crawlFirstPartyContactEmails(
  domain: string,
  options?: { maxPages?: number; overallDeadlineMs?: number; pageTimeoutMs?: number }
): Promise<ContactPageCrawlResult> {
  const { safeFetch } = await import("./safe-fetch");

  const baseUrl = domain.startsWith("http") ? domain : `https://${domain}`;
  let baseUrlObj: URL;
  try {
    baseUrlObj = new URL(baseUrl);
  } catch {
    return { candidates: [], fetchCompleted: false, pagesAttempted: 0 };
  }

  const safe = await isSafeFetchTarget(baseUrl);
  if (!safe) {
    console.info(`[ContactPageCrawl] SSRF blocked domain: ${domain}`);
    // SSRF block is a valid skip, not a transient transport failure.
    return { candidates: [], fetchCompleted: true, pagesAttempted: 0 };
  }

  const maxPages = Math.max(1, options?.maxPages ?? CRAWL_MAX_PAGES);
  const pageTimeoutMs = options?.pageTimeoutMs ?? CRAWL_PAGE_TIMEOUT_MS;
  const deadlineAt = Date.now() + (options?.overallDeadlineMs ?? CRAWL_OVERALL_DEADLINE_MS);
  const urlsToTry = [baseUrl, ...PRIORITY_CRAWL_PATHS.map(p => baseUrlObj.origin + p)].slice(0, maxPages);

  const byEmail = new Map<string, ContactPageCrawlCandidate>();
  let rootFetchCompleted = false;
  let pagesAttempted = 0;

  for (const url of urlsToTry) {
    if (Date.now() >= deadlineAt) break;
    pagesAttempted++;
    try {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) break;
      const resp = await safeFetch(url, { timeoutMs: Math.min(pageTimeoutMs, remaining) });
      if (url === baseUrl) rootFetchCompleted = resp !== null;
      if (resp?.ok) {
        const html = resp.body ?? "";
        for (const candidate of extractCandidatesFromPage(html, url)) {
          const existing = byEmail.get(candidate.email);
          if (!existing || (candidate.evidenceType === "mailto" && existing.evidenceType !== "mailto")) {
            byEmail.set(candidate.email, candidate);
          }
        }
      }
      if (url !== baseUrl) await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
    } catch {
      // non-fatal: proceed to next page within the deadline
    }
  }

  return { candidates: Array.from(byEmail.values()), fetchCompleted: rootFetchCompleted, pagesAttempted };
}

/**
 * Contact-discovery email acceptance/ranking policy — deliberately distinct
 * from isOwnerLikeEmail() above. This is used only by the new contact-level
 * discovery path in enrichment.ts and accepts common role inboxes
 * (info@/contact@/sales@/hello@/support@) that the legacy owner-only policy
 * rejects, because a role inbox is still a usable outreach address for a
 * contact record even though it's a poor "owner" guess for sdr_merchants.
 *
 * Deterministic ranking: mailto evidence and same-registrable-domain matches
 * outrank a visible-text or off-domain (e.g. free/hosted) address, but a
 * genuinely-present hosted address is still allowed at lower confidence
 * rather than discarded outright. A tie at the top score is reported as
 * ambiguous (no selection) rather than guessed.
 */
export interface ContactDiscoverySelection {
  email: string | null;
  sourceUrl: string | null;
  confidence: number;
  ambiguous: boolean;
}

export const CONTACT_DISCOVERY_ACCEPTED_PREFIXES = ["info", "contact", "sales", "hello", "support"];

/**
 * True for a role/shared inbox local-part (info@, sales@, etc) — the only
 * kind of address Task #1978's free-discovery domain cache is allowed to
 * reuse across contacts at the same business. Anything else (a person's
 * name, a numbered/ticket alias, etc) must stay scoped to the one contact it
 * was found for and never be cached or copied elsewhere (correction #4).
 */
export function isRoleInboxEmail(email: string): boolean {
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  return CONTACT_DISCOVERY_ACCEPTED_PREFIXES.some(p => local === p || local.startsWith(p + "."));
}
const FREE_HOSTED_EMAIL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com", "mail.com", "protonmail.com",
]);

// Common two-label public suffixes where the registrable domain needs THREE
// labels, not two (e.g. "example.co.uk", not "co.uk"). Not an exhaustive
// public-suffix-list implementation, but covers the ccTLD patterns most
// likely to appear among crawled business sites; anything else falls back to
// the last-two-labels heuristic.
const TWO_LABEL_PUBLIC_SUFFIXES = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
  "co.nz", "org.nz", "govt.nz", "ac.nz",
  "co.za", "org.za", "gov.za",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "com.br", "net.br", "org.br",
  "co.in", "net.in", "org.in", "gov.in", "co.il", "org.il",
  "com.mx", "com.sg", "com.hk", "co.kr", "com.cn", "com.tw",
  "com.ar", "com.co", "com.pe", "com.tr", "com.my", "com.ph", "com.vn",
]);

/**
 * Best-effort registrable-domain extraction. Not a full public-suffix-list
 * implementation, but distinguishes "example.co.uk" from "co.uk" for the
 * ccTLD patterns in TWO_LABEL_PUBLIC_SUFFIXES above, which the naive
 * last-two-labels approach would otherwise treat as an exact match for any
 * two unrelated ".co.uk" (etc.) sites.
 */
export function registrableDomain(rawDomain: string): string {
  const clean = rawDomain.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[\/?#]/)[0].toLowerCase();
  const parts = clean.split(".").filter(Boolean);
  if (parts.length <= 2) return clean;
  const lastTwo = parts.slice(-2).join(".");
  if (TWO_LABEL_PUBLIC_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return lastTwo;
}

/**
 * Hard eligibility gate — separate from ranking. An address is only ever
 * eligible for contact-discovery selection if it matches the crawled site's
 * own registrable domain, or is on an explicitly allowed free/hosted email
 * domain. Everything else (vendor attribution, embedded third-party scripts,
 * agency-footer addresses, legal-page boilerplate) is excluded outright,
 * regardless of mailto evidence or role-prefix — a mailto link or a
 * "sales@" prefix does not prove the address belongs to the crawled
 * business itself.
 */
function isEligibleContactDiscoveryCandidate(candidate: ContactPageCrawlCandidate, siteRegistrable: string): boolean {
  const candidateDomain = candidate.email.split("@")[1] || "";
  if (registrableDomain(candidateDomain) === siteRegistrable) return true;
  if (FREE_HOSTED_EMAIL_DOMAINS.has(candidateDomain)) return true;
  return false;
}

function rankContactDiscoveryCandidate(candidate: ContactPageCrawlCandidate, siteRegistrable: string): number {
  let score = 0;
  if (candidate.evidenceType === "mailto") score += 50;
  const candidateDomain = candidate.email.split("@")[1] || "";
  if (registrableDomain(candidateDomain) === siteRegistrable) {
    score += 30;
  } else {
    // Only reachable for FREE_HOSTED_EMAIL_DOMAINS — off-domain,
    // non-hosted candidates are excluded before ranking by
    // isEligibleContactDiscoveryCandidate() and never reach this function.
    score += 5;
  }
  const local = candidate.email.split("@")[0].toLowerCase();
  if (CONTACT_DISCOVERY_ACCEPTED_PREFIXES.some(p => local === p || local.startsWith(p + "."))) {
    score += 10;
  }
  return score;
}

export function selectContactDiscoveryEmail(
  candidates: ContactPageCrawlCandidate[],
  domain: string
): ContactDiscoverySelection {
  // isJunkCandidateEmail() already ran during extraction; candidates here
  // are already role-inbox-friendly (info@/contact@/etc. are NOT filtered
  // out, unlike isOwnerLikeEmail()). Dedupe defensively by email.
  const byEmail = new Map<string, ContactPageCrawlCandidate>();
  for (const c of candidates) {
    if (!byEmail.has(c.email)) byEmail.set(c.email, c);
  }
  const siteRegistrable = registrableDomain(domain);

  // Hard eligibility gate BEFORE ranking: an off-domain, non-hosted address
  // (vendor attribution, embedded third-party script, agency-footer email,
  // legal boilerplate) is never selectable, even as the lone candidate on
  // the page and even with mailto evidence.
  const eligible = Array.from(byEmail.values())
    .filter(c => isEligibleContactDiscoveryCandidate(c, siteRegistrable));

  if (eligible.length === 0) {
    return { email: null, sourceUrl: null, confidence: 0, ambiguous: false };
  }

  const ranked = eligible
    .map(c => ({ ...c, score: rankContactDiscoveryCandidate(c, siteRegistrable) }))
    .sort((a, b) => b.score - a.score || a.email.localeCompare(b.email));

  const topScore = ranked[0].score;
  const topTiedEmails = new Set(ranked.filter(c => c.score === topScore).map(c => c.email));
  if (topTiedEmails.size > 1) {
    return { email: null, sourceUrl: null, confidence: topScore, ambiguous: true };
  }

  return { email: ranked[0].email, sourceUrl: ranked[0].sourceUrl, confidence: topScore, ambiguous: false };
}
