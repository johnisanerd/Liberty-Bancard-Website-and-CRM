import { db } from "../../db";
import { sdrMerchants, sdrMerchantContacts } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { isSafeFetchTarget } from "./url-safety";

const BUSINESS_TYPES = new Set([
  "LocalBusiness", "Dentist", "AutoRepair", "MedicalBusiness", "JewelryStore",
  "VeterinaryCare", "Restaurant", "HealthAndBeautyBusiness", "LegalService",
  "AccountingService", "FinancialService", "HomeAndConstructionBusiness",
  "FoodEstablishment", "MedicalClinic", "Physician", "Attorney",
  "RealEstateAgent", "InsuranceAgency", "Plumber", "Electrician",
  "HairSalon", "BeautySalon", "DayCare", "ChildCare", "SportingGoodsStore",
  "ClothingStore", "FurnitureStore", "BookStore", "ElectronicsStore",
  "AutoDealer", "HardwareStore", "PetStore",
]);

interface JsonLdResult {
  email: string | null;
  contactName: string | null;
}

function extractFromObject(obj: any): JsonLdResult {
  const result: JsonLdResult = { email: null, contactName: null };
  if (!obj || typeof obj !== "object") return result;

  const type = obj["@type"] || "";
  const types = Array.isArray(type) ? type : [type];
  const isBusinessType = types.some((t: string) => BUSINESS_TYPES.has(t));

  if (isBusinessType) {
    if (typeof obj.email === "string" && obj.email.includes("@")) {
      result.email = obj.email.trim().toLowerCase();
    }

    const founder = obj.founder;
    if (founder) {
      const f = Array.isArray(founder) ? founder[0] : founder;
      if (f?.name && typeof f.name === "string") {
        result.contactName = f.name.trim();
      }
    }

    if (!result.contactName) {
      const employee = obj.employee;
      if (employee) {
        const e = Array.isArray(employee) ? employee[0] : employee;
        if (e?.name && typeof e.name === "string") {
          result.contactName = e.name.trim();
        }
      }
    }
  }

  return result;
}

function extractJsonLdFromHtml(html: string): JsonLdResult {
  const scriptRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let bestResult: JsonLdResult = { email: null, contactName: null };

  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const raw = JSON.parse(match[1]);
      const items = Array.isArray(raw) ? raw : [raw];
      for (const item of items) {
        const result = extractFromObject(item);
        if (result.email && !bestResult.email) bestResult.email = result.email;
        if (result.contactName && !bestResult.contactName) bestResult.contactName = result.contactName;
        if (bestResult.email && bestResult.contactName) return bestResult;
      }
    } catch {
    }
  }
  return bestResult;
}

async function fetchHomepageHtml(website: string): Promise<string | null> {
  let url = website;
  if (!url.startsWith("http")) url = `https://${url}`;
  url = url.replace(/\/$/, "");

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

export async function runJsonLdEnrichment(merchantId: number): Promise<{ enriched: boolean; emailFound: boolean; source: "jsonld" }> {
  const [merchant] = await db.select().from(sdrMerchants).where(eq(sdrMerchants.id, merchantId));
  if (!merchant?.website && !merchant?.domain) return { enriched: false, emailFound: false, source: "jsonld" };

  const siteUrl = merchant.website || merchant.domain!;
  const normalizedUrl = siteUrl.startsWith("http") ? siteUrl : `https://${siteUrl}`;
  const safe = await isSafeFetchTarget(normalizedUrl);
  if (!safe) {
    console.info(`[JSON-LD] Blocked unsafe URL for merchant ${merchantId}: ${siteUrl}`);
    return { enriched: false, emailFound: false, source: "jsonld" };
  }
  const html = await fetchHomepageHtml(siteUrl);
  if (!html) return { enriched: false, emailFound: false, source: "jsonld" };

  const result = extractJsonLdFromHtml(html);
  if (!result.email && !result.contactName) return { enriched: false, emailFound: false, source: "jsonld" };

  const emailFound = !!result.email;

  await db.insert(sdrMerchantContacts).values({
    merchantId,
    contactName: result.contactName || null,
    email: result.email || null,
    roleGuess: "owner",
    emailConfidence: 90,
    primaryContactFlag: false,
  } as any);

  return { enriched: emailFound, emailFound, source: "jsonld" };
}

export async function runJsonLdEnrichmentBatch(limit = 50): Promise<{ processed: number; enriched: number }> {
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
      const res = await runJsonLdEnrichment(m.id);
      processed++;
      if (res.enriched) enriched++;
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`[JSON-LD] Error enriching merchant ${m.id}:`, err);
      processed++;
    }
  }
  console.log(`[JSON-LD] Batch done: ${processed} processed, ${enriched} enriched`);
  return { processed, enriched };
}

/**
 * Business-scoped JSON-LD enrichment — MI-04 free enrichment path.
 *
 * Accepts a businessId + domain. Writes evidence to businesses columns only.
 * Never writes sdr_merchant_contacts rows.
 *
 * Correction #1: returns the actual email address(es) found in addition to the
 * count, so callers can persist them as encrypted free_discovery_candidates.
 * emailCount and emailFound are retained for backwards-compat; emails[] is the
 * source of truth for the candidate-persistence path.
 */
export interface JsonLdBusinessResult {
  emailFound: boolean;
  emailCount: number;
  /** Actual normalized email addresses extracted from JSON-LD schema markup. */
  emails: string[];
  /** true when the fetch round-trip completed (even if no data); false on transport/SSRF failure */
  fetchCompleted: boolean;
}

export async function runJsonLdBusinessEnrichment(
  businessId: number,
  domain: string
): Promise<JsonLdBusinessResult> {
  const { isSafeFetchTarget } = await import("./url-safety");
  const { safeFetch } = await import("./safe-fetch");
  const websiteUrl = domain.startsWith("http") ? domain : `https://${domain}`;

  // SSRF check before any network request
  const safe = await isSafeFetchTarget(websiteUrl);
  if (!safe) {
    console.info(`[JSON-LD-Business] SSRF blocked domain for business ${businessId}: ${domain}`);
    // SSRF block is a valid skip — not a transient transport failure.
    return { emailFound: false, emailCount: 0, emails: [], fetchCompleted: true };
  }

  // safeFetch returns null on SSRF block, timeout, or DNS failure — transport failure.
  const resp = await safeFetch(websiteUrl, { timeoutMs: 10000 });
  if (!resp) {
    console.info(`[JSON-LD-Business] safeFetch transport failure for business ${businessId}: ${domain}`);
    return { emailFound: false, emailCount: 0, emails: [], fetchCompleted: false };
  }
  // Non-OK HTTP response (e.g. 404, 503) — fetch completed, site returned an error.
  if (!resp.ok) return { emailFound: false, emailCount: 0, emails: [], fetchCompleted: true };

  // body is eagerly read by safeFetch — no separate async read needed
  const html = resp.body ?? "";
  const result = extractJsonLdFromHtml(html);
  const emails: string[] = result.email ? [result.email] : [];
  const emailFound = emails.length > 0;
  const emailCount = emails.length;

  console.log(`[JSON-LD-Business] Business ${businessId}: emailFound=${emailFound}`);
  return { emailFound, emailCount, emails, fetchCompleted: true };
}
