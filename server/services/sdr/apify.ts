import { storage } from "../../storage";
import { assertProviderActivation } from "../provider-manifest";

const APIFY_API_URL = "https://api.apify.com/v2";

export interface ApifyBusiness {
  name: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  rating: number | null;
  reviewCount: number | null;
  category: string | null;
  sourceUrl: string | null;
  rawData: Record<string, any>;
}

interface ApifyUsageStats {
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  businessesFound: number;
  lastRunAt: string | null;
  estimatedCost: number;
}

const APIFY_ACTORS = {
  yelp: "johnvc/yelp-search-api",
  facebook: "apify/facebook-pages-scraper",
  google_maps: "compass/crawler-google-places",
};

export function isApifyConfigured(): boolean {
  return !!process.env.APIFY_API_TOKEN;
}

async function trackApifyRun(success: boolean, businessesFound: number = 0) {
  try {
    const existing = await storage.getSystemSetting("apify_usage") as ApifyUsageStats | null;
    const stats: ApifyUsageStats = existing || {
      totalRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,
      businessesFound: 0,
      lastRunAt: null,
      estimatedCost: 0,
    };
    stats.totalRuns++;
    if (success) {
      stats.successfulRuns++;
      stats.businessesFound += businessesFound;
      stats.estimatedCost += 0.05 + businessesFound * 0.001;
    } else {
      stats.failedRuns++;
    }
    stats.lastRunAt = new Date().toISOString();
    await storage.setSystemSetting("apify_usage", stats);
  } catch (err) {
    console.error("[Apify] Usage tracking error:", err);
  }
}

export async function getApifyUsage(): Promise<ApifyUsageStats> {
  const stats = await storage.getSystemSetting("apify_usage") as ApifyUsageStats | null;
  return stats || {
    totalRuns: 0,
    successfulRuns: 0,
    failedRuns: 0,
    businessesFound: 0,
    lastRunAt: null,
    estimatedCost: 0,
  };
}

function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d]/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function extractDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function parseYelpResult(raw: Record<string, any>): ApifyBusiness {
  return {
    name: raw.title || "",
    phone: normalizePhone(raw.phone),
    email: raw.email || null,
    website: extractDomain(raw.website),
    address: raw.address || raw.fullAddress || null,
    city: raw.city || null,
    state: raw.state || null,
    zip: raw.zipCode || raw.zip || null,
    rating: raw.rating ? parseFloat(raw.rating) : null,
    reviewCount: raw.reviews ? parseInt(raw.reviews) : null,
    category: Array.isArray(raw.categories) ? raw.categories[0]?.title || raw.categories[0] || null : null,
    sourceUrl: raw.link || null,
    rawData: raw,
  };
}

function parseFacebookResult(raw: Record<string, any>): ApifyBusiness {
  return {
    name: raw.name || raw.title || "",
    phone: normalizePhone(raw.phone),
    email: raw.email || raw.emails?.[0] || null,
    website: extractDomain(raw.website),
    address: raw.address || null,
    city: raw.city || null,
    state: raw.state || null,
    zip: raw.zip || null,
    rating: raw.overallStarRating ? parseFloat(raw.overallStarRating) : null,
    reviewCount: raw.reviewsCount ? parseInt(raw.reviewsCount) : null,
    category: raw.categoryName || raw.categories?.[0] || null,
    sourceUrl: raw.url || raw.pageUrl || null,
    rawData: raw,
  };
}

async function runApifyActor(
  actorId: string,
  input: Record<string, any>,
  timeoutSecs: number = 120
): Promise<Record<string, any>[]> {
  assertProviderActivation({
    sourceId: "apify",
    caller: "unapproved",
    explicitPaidApproval: false,
  });
  if (!process.env.APIFY_API_TOKEN) {
    console.warn("[Apify] No API token configured. Set APIFY_API_TOKEN env variable.");
    return [];
  }

  try {
    const runResponse = await fetch(`${APIFY_API_URL}/acts/${actorId}/run-sync-get-dataset-items?token=${process.env.APIFY_API_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...input,
        maxItems: input.maxItems || 200,
      }),
      signal: AbortSignal.timeout(timeoutSecs * 1000),
    });

    if (!runResponse.ok) {
      const errorText = await runResponse.text().catch(() => "Unknown error");
      console.error(`[Apify] Actor ${actorId} error ${runResponse.status}: ${errorText}`);
      await trackApifyRun(false);
      return [];
    }

    const items = await runResponse.json();
    return Array.isArray(items) ? items : [];
  } catch (err) {
    console.error(`[Apify] Actor ${actorId} error:`, err);
    await trackApifyRun(false);
    return [];
  }
}

export async function searchYelp(
  searchTerm: string,
  location: string,
  limit: number = 200
): Promise<ApifyBusiness[]> {
  const items = await runApifyActor(APIFY_ACTORS.yelp, {
    search_term: searchTerm,
    location,
    max_pages: Math.ceil(Math.min(limit, 500) / 10),
  });

  const errorPage = items.find(page => page.error);
  if (errorPage) console.warn(`[Apify/Yelp] Actor error: ${errorPage.error_message || errorPage.error}`);

  const results = items
    .filter(page => !page.error)
    .flatMap(page => Array.isArray(page.organic_results) ? page.organic_results : [])
    .map(parseYelpResult)
    .filter(b => b.name)
    .slice(0, limit);
  await trackApifyRun(true, results.length);
  console.log(`[Apify/Yelp] Found ${results.length} businesses for: ${searchTerm} in ${location}`);
  return results;
}

export async function searchFacebook(
  searchQuery: string,
  limit: number = 100
): Promise<ApifyBusiness[]> {
  const items = await runApifyActor(APIFY_ACTORS.facebook, {
    searchQueries: [searchQuery],
    maxItems: Math.min(limit, 200),
  });

  const results = items.map(parseFacebookResult).filter(b => b.name);
  await trackApifyRun(true, results.length);
  console.log(`[Apify/Facebook] Found ${results.length} businesses for: ${searchQuery}`);
  return results;
}

export async function searchApifyByVerticalMetro(
  vertical: string,
  metro: string,
  state: string = "FL",
  sources: string[] = ["yelp"]
): Promise<ApifyBusiness[]> {
  const allResults: ApifyBusiness[] = [];
  const location = `${metro}, ${state}`;

  for (const source of sources) {
    try {
      if (source === "yelp") {
        const results = await searchYelp(vertical, location);
        allResults.push(...results);
      } else if (source === "facebook") {
        const results = await searchFacebook(`${vertical} ${location}`);
        allResults.push(...results);
      }
    } catch (err) {
      console.error(`[Apify] Error with source ${source}:`, err);
    }
  }

  return allResults;
}
