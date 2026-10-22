import type { Express } from "express";
import { getIndustryHtml } from "../ssr/industries";
import { INDUSTRY_SLUGS } from "../../shared/blog-slugs";
import { getCompareHtml } from "../ssr/compare";
import { getLocationHtml, getCityHubHtml } from "../ssr/locations";
import { isValidLocationCombination } from "../ssr/location-html";
import { getHomeHtml } from "../ssr/home";
import {
  getUploadStatementHtml,
  getFreeAnalysisHtml,
  getFreeAnalysisGuaranteedHtml,
  getWhyLibertyHtml,
  getZeroPercentHtml,
  getCaseStudiesHtml,
  getEstimateHtml,
  getSavingsCalculatorHtml,
  getCompareRatesHtml,
  getGetStartedHtml,
  getBeatSquareStripeHtml,
  getAffiliateProgramHtml,
  getFaqHtml,
  getTestimonialsHtml,
  getTestimonialsSubmitHtml,
  getIntegrationsHtml,
  getFreeSmartTerminalHtml,
} from "../ssr/pages";
import { CITIES, VERTICALS } from "../ssr/location-data";
import { storage } from "../storage";
import { renderBlogPostHtml, renderBlogHubHtml } from "../ssr/blog-ssr-data";
import { renderAlternativesHtml, renderSwitchFromHtml, getAvailableCompetitorSlugs } from "../ssr/competitor-ssr";
import { allBlogPostsServer } from "../ssr/all-blog-posts-server";
import type { BlogPost } from "../ssr/blog-ssr-data";

let dbPostsCache: BlogPost[] | null = null;
let dbCacheTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

async function getAllBlogPosts(): Promise<BlogPost[]> {
  const now = Date.now();
  if (dbPostsCache && now - dbCacheTime < CACHE_TTL_MS) {
    return [...allBlogPostsServer, ...dbPostsCache];
  }

  let dbPosts: BlogPost[] = [];
  try {
    const published = await storage.getGeneratedBlogPosts("published");
    const staticSlugs = new Set(allBlogPostsServer.map(p => p.slug));
    dbPosts = published
      .filter((p: any) => !staticSlugs.has(p.slug))
      .map((p: any): BlogPost => ({
        slug: p.slug,
        title: p.title,
        excerpt: p.excerpt,
        category: p.category,
        author: p.author,
        readTime: p.readTime,
        publishDate: p.publishDate,
        publishedISO: p.publishedISO,
        modifiedISO: p.modifiedISO,
        keywords: p.keywords,
        metaDescription: p.metaDescription,
        content: p.content,
        faqs: p.faqs ?? undefined,
      }));
  } catch {
    dbPosts = [];
  }

  dbPostsCache = dbPosts;
  dbCacheTime = now;
  return [...allBlogPostsServer, ...dbPosts];
}

function notFoundHtml(title: string, message: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${title} | Liberty Bancard</title><style>body{font-family:sans-serif;text-align:center;padding:4rem 2rem;}a{color:#3b82f6;}</style></head><body><h1>${title}</h1><p>${message}</p><p><a href="/">Return Home</a></p></body></html>`;
}

const today = () => new Date().toISOString().split("T")[0];
const baseUrl = "https://libertybancard.com";

const COMPETITOR_SLUGS = [
  "square", "stripe", "clover", "toast", "paypal",
  "helcim", "authorize-net", "shopify-payments", "heartland",
  "worldpay", "fiserv", "gravity-payments",
];

const isDev = process.env.NODE_ENV !== "production";
// Home page: CDN holds 5 min fresh, serves stale up to 1 hour while revalidating
const SSR_CACHE = isDev ? "no-store, no-cache" : "public, s-maxage=300, stale-while-revalidate=3600";
// Marketing/SSR pages: browser holds 5 min, CDN up to 1 hour with stale-while-revalidate
const PAGE_CACHE = isDev ? "no-store, no-cache" : "public, max-age=300, s-maxage=3600, stale-while-revalidate=3600";
// City pages: slightly longer — 15 min browser, 2 hour CDN
const CITY_CACHE = isDev ? "no-store, no-cache" : "public, max-age=900, s-maxage=7200, stale-while-revalidate=3600";

export function registerSsrRoutes(app: Express) {
  // Canonical trailing-slash redirect: /path/ → /path (301).
  // Consolidates link equity to the canonical URL for every SSR-served path.
  // Skips root `/` and any path starting with `/api/` (API routes handled upstream).
  app.use((req, res, next) => {
    if (
      req.path.length > 1 &&
      req.path.endsWith("/") &&
      !req.path.startsWith("/api/")
    ) {
      const cleanPath = req.path.slice(0, -1);
      const qs = req.url.slice(req.path.length); // preserve ?query string
      return res.redirect(301, cleanPath + qs);
    }
    next();
  });

  // Legacy URL redirect: /thanks-application → /thanks/application (301).
  // Both URLs would otherwise resolve to different React routes; consolidate
  // to the canonical path so crawlers index only one version.
  app.get("/thanks-application", (_req, res) => {
    res.redirect(301, "/thanks/application");
  });

  // Legal URL redirects: /legal/* → canonical legal page URLs (301).
  // External links (GHL emails, partner docs, referrals) may use /legal/* format;
  // these redirects prevent 404s and consolidate SEO equity to the canonical URLs.
  app.get("/legal/privacy", (_req, res) => {
    res.redirect(301, "/privacy-policy");
  });
  app.get("/legal/privacy-policy", (_req, res) => {
    res.redirect(301, "/privacy-policy");
  });
  app.get("/legal/terms", (_req, res) => {
    res.redirect(301, "/terms");
  });
  app.get("/legal/pci", (_req, res) => {
    res.redirect(301, "/security-compliance");
  });

  app.get("/", (_req, res) => {
    const html = getHomeHtml();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", SSR_CACHE);
    res.send(html);
  });

  app.get("/industries/:slug", (req, res, next) => {
    const html = getIndustryHtml(req.params.slug);
    // Listed industries without a server-rendered page are client-rendered pages: serve the app, not an empty 404.
    if (!html && (INDUSTRY_SLUGS as readonly string[]).includes(req.params.slug)) return next();
    if (!html) return res.status(404).end();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", PAGE_CACHE);
    res.send(html);
  });

  app.get("/compare/:competitor", (req, res) => {
    const html = getCompareHtml(req.params.competitor);
    if (!html) return res.status(404).end();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", PAGE_CACHE);
    res.send(html);
  });

  app.get("/locations/:city/:industry", (req, res) => {
    const html = getLocationHtml(req.params.city, req.params.industry);
    if (!html) return res.status(404).end();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", CITY_CACHE);
    res.send(html);
  });

  app.get("/locations/:city", (req, res) => {
    const html = getCityHubHtml(req.params.city);
    if (!html) return res.status(404).end();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", PAGE_CACHE);
    res.send(html);
  });

  app.get("/sitemap-locations.xml", (_req, res) => {
    const date = today();

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;

    for (const city of CITIES) {
      xml += `  <url>\n`;
      xml += `    <loc>${baseUrl}/locations/${city.slug}</loc>\n`;
      xml += `    <lastmod>${date}</lastmod>\n`;
      xml += `    <changefreq>monthly</changefreq>\n`;
      xml += `    <priority>0.7</priority>\n`;
      xml += `  </url>\n`;

      for (const vertical of VERTICALS) {
        if (!isValidLocationCombination(city.slug, vertical.slug)) continue;
        xml += `  <url>\n`;
        xml += `    <loc>${baseUrl}/locations/${city.slug}/${vertical.slug}</loc>\n`;
        xml += `    <lastmod>${date}</lastmod>\n`;
        xml += `    <changefreq>monthly</changefreq>\n`;
        xml += `    <priority>0.7</priority>\n`;
        xml += `  </url>\n`;
      }
    }

    xml += `</urlset>`;
    res.set("Content-Type", "application/xml");
    res.send(xml);
  });

  app.get("/upload-statement", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", PAGE_CACHE);
    res.send(getUploadStatementHtml());
  });

  app.get("/free-analysis", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", PAGE_CACHE);
    res.send(getFreeAnalysisHtml());
  });

  app.get("/free-analysis-guaranteed", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", PAGE_CACHE);
    res.send(getFreeAnalysisGuaranteedHtml());
  });

  app.get("/why-liberty-bancard", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", PAGE_CACHE);
    res.send(getWhyLibertyHtml());
  });

  app.get("/0-percent-processing", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", PAGE_CACHE);
    res.send(getZeroPercentHtml());
  });

  app.get("/case-studies", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", PAGE_CACHE);
    res.send(getCaseStudiesHtml());
  });

  app.get("/equipment", (_req, res) => {
    res.redirect(301, "/shop");
  });

  app.get("/estimate", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", PAGE_CACHE);
    res.send(getEstimateHtml());
  });

  app.get("/savings-calculator", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", PAGE_CACHE);
    res.send(getSavingsCalculatorHtml());
  });

  app.get("/compare-rates", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", PAGE_CACHE);
    res.send(getCompareRatesHtml());
  });

  app.get("/get-started", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", PAGE_CACHE);
    res.send(getGetStartedHtml());
  });

  app.get("/beat-square-stripe", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", PAGE_CACHE);
    res.send(getBeatSquareStripeHtml());
  });

  app.get("/affiliate", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", PAGE_CACHE);
    res.send(getAffiliateProgramHtml());
  });

  app.get("/faq", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", PAGE_CACHE);
    res.send(getFaqHtml());
  });

  app.get("/free-smart-terminal", (req, res, next) => {
    if (!isCrawler(req.headers["user-agent"])) return next();
    const html = getFreeSmartTerminalHtml();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", PAGE_CACHE);
    res.send(html);
  });

  app.get("/testimonials", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", PAGE_CACHE);
    res.send(getTestimonialsHtml());
  });

  app.get("/testimonials/submit", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(getTestimonialsSubmitHtml());
  });

  app.get("/integrations", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", PAGE_CACHE);
    res.send(getIntegrationsHtml());
  });

  // /blog and /blog/:slug are handled by the React SPA so they render the
  // full site Navbar (with dropdowns, phone, Book 10-Min Call, Upload
  // Statement) and Footer that match other public pages. SEO metadata and
  // structured data for these pages are provided client-side by the
  // <SEO /> component in Blog.tsx and BlogPost.tsx via react-helmet-async.
  // We still serve SSR HTML to known crawlers so search engines see the
  // metadata without needing to execute JavaScript.
  const isCrawler = (ua: string | undefined): boolean => {
    if (!ua) return false;
    return /bot|crawler|spider|crawling|googlebot|bingbot|yandex|duckduckbot|baiduspider|facebookexternalhit|twitterbot|linkedinbot|slackbot|whatsapp|telegrambot|applebot|ahrefsbot|semrushbot|mj12bot|dotbot|petalbot|gptbot|claudebot|chatgpt-user|perplexitybot|ccbot/i.test(ua);
  };

  app.get("/blog", async (req, res, next) => {
    if (!isCrawler(req.headers["user-agent"])) {
      return next();
    }
    try {
      const posts = await getAllBlogPosts();
      const html = renderBlogHubHtml(posts);
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch (err) {
      console.error("[SSR] Blog hub error:", err);
      next();
    }
  });

  app.get("/blog/:slug", async (req, res, next) => {
    if (!isCrawler(req.headers["user-agent"])) {
      return next();
    }
    const slug = req.params.slug;
    try {
      const posts = await getAllBlogPosts();
      const post = posts.find(p => p.slug === slug);

      if (!post) {
        return next();
      }

      const html = renderBlogPostHtml(post);
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch (err) {
      console.error("[SSR] Blog post error:", err);
      next();
    }
  });

  app.get("/alternatives/:competitor", (req, res) => {
    const competitor = req.params.competitor;
    const availableSlugs = getAvailableCompetitorSlugs();

    if (!availableSlugs.includes(competitor)) {
      res.status(404).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(notFoundHtml("Alternatives Page Not Found", `We don't have an alternatives page for "${competitor}" yet.`));
      return;
    }

    const html = renderAlternativesHtml(competitor);
    res.setHeader("Cache-Control", PAGE_CACHE);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  });

  app.get("/switch-from/:competitor", (req, res) => {
    const competitor = req.params.competitor;
    const availableSlugs = getAvailableCompetitorSlugs();

    if (!availableSlugs.includes(competitor)) {
      res.status(404).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(notFoundHtml("Switch-From Page Not Found", `We don't have a switch-from guide for "${competitor}" yet.`));
      return;
    }

    const html = renderSwitchFromHtml(competitor);
    res.setHeader("Cache-Control", PAGE_CACHE);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  });

  app.get("/sitemap-blog.xml", async (_req, res) => {
    const posts = await getAllBlogPosts();
    const date = today();

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
    xml += `  <url><loc>${baseUrl}/blog</loc><lastmod>${date}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>\n`;
    for (const post of posts) {
      const lastmod = post.modifiedISO ? post.modifiedISO.split("T")[0] : date;
      xml += `  <url><loc>${baseUrl}/blog/${post.slug}</loc><lastmod>${lastmod}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>\n`;
    }
    xml += `</urlset>`;

    res.set("Content-Type", "application/xml");
    res.send(xml);
  });

  app.get("/sitemap-compare.xml", (_req, res) => {
    const date = today();
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
    for (const slug of COMPETITOR_SLUGS) {
      // List /compare/<slug> only when that page exists; /compare/:competitor answers 404 for slugs without a comparison page.
      if (getCompareHtml(slug)) xml += `  <url><loc>${baseUrl}/compare/${slug}</loc><lastmod>${date}</lastmod><changefreq>monthly</changefreq><priority>0.8</priority></url>\n`;
      xml += `  <url><loc>${baseUrl}/alternatives/${slug}</loc><lastmod>${date}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>\n`;
      xml += `  <url><loc>${baseUrl}/switch-from/${slug}</loc><lastmod>${date}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>\n`;
    }
    xml += `</urlset>`;

    res.set("Content-Type", "application/xml");
    res.send(xml);
  });

  app.get("/sitemap-index.xml", (_req, res) => {
    const date = today();
    const sitemaps = [
      "/sitemap.xml",
      "/sitemap-blog.xml",
      "/sitemap-compare.xml",
      "/sitemap-locations.xml",
    ];

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
    for (const sm of sitemaps) {
      xml += `  <sitemap><loc>${baseUrl}${sm}</loc><lastmod>${date}</lastmod></sitemap>\n`;
    }
    xml += `</sitemapindex>`;

    res.set("Content-Type", "application/xml");
    res.send(xml);
  });
}
