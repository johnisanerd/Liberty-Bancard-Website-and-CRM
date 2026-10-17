import { lookup } from "node:dns/promises";
import dns from "node:dns";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";

export interface WebsiteClassificationEvidence {
  sourceUrl: string;
  pageType: string;
  jsonLdTypes: string[];
  titleTokens: string[];
  metaTokens: string[];
  serviceTokens: string[];
  categoryTokens: string[];
  /**
   * Retained business-description text. The token lists above keep only a narrow keyword
   * vocabulary, which cannot show what a business actually does, so the page's own title,
   * meta description and h1-h3 headings are kept (bounded) as the service description that
   * classification and the acceptance policy read. Optional so older stored evidence stays valid.
   */
  titleText?: string;
  metaDescription?: string;
  headings?: string[];
  capturedAt: string;
  contentHash: string;
}

type ResolveImpl = (hostname: string) => Promise<string | string[]>;

export async function extractWebsiteClassificationEvidence(
  url: string,
  opts?: {
    fetchImpl?: typeof fetch;
    maxBodyBytes?: number;
    timeoutMs?: number;
    resolveImpl?: ResolveImpl;
  },
): Promise<WebsiteClassificationEvidence | { error: string }> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { error: "invalid_url" };
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return { error: "unsupported_protocol" };
  }
  if (parsedUrl.username || parsedUrl.password) {
    return { error: "credentials_not_allowed" };
  }
  if (parsedUrl.port && parsedUrl.port !== "80" && parsedUrl.port !== "443") {
    return { error: "blocked_port" };
  }

  try {
    const resolved = await (opts?.resolveImpl ?? resolveHostname)(parsedUrl.hostname);
    const addresses = Array.isArray(resolved) ? resolved : [resolved];
    if (!addresses.length || addresses.some(isBlockedAddress)) {
      return { error: "blocked_private_target" };
    }
  } catch {
    return { error: "dns_resolution_failed" };
  }

  const maxBodyBytes = Math.max(0, Math.floor(opts?.maxBodyBytes ?? 500_000));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, opts?.timeoutMs ?? 8_000));
  // The pre-check above proves the hostname resolved to a public address at
  // the time of the check, but plain `fetch` performs its OWN independent
  // DNS resolution when it actually opens the connection — a second lookup
  // a moment later can legitimately return a different address (DNS
  // rebinding), silently defeating the pre-check (TOCTOU). When no fake
  // `fetchImpl` is injected (i.e. this is a real network call, not a test),
  // pin the actual TCP connection to a `lookup` that re-validates on every
  // real connection attempt rather than trusting a separate earlier check —
  // there is exactly one DNS resolution and it is the one used to connect,
  // so there is no window in which the validated address and the connected
  // address can differ.
  const pinnedDispatcher = opts?.fetchImpl ? null : new UndiciAgent({
    connect: {
      lookup: (hostname, lookupOpts, callback) => {
        dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
          if (err) return callback(err, [] as any);
          const list = (Array.isArray(addresses) ? addresses : [addresses]) as Array<{ address: string; family: number }>;
          if (!list.length || list.some((a) => isBlockedAddress(a.address))) {
            return callback(new Error("blocked_private_target"), [] as any);
          }
          callback(null, list as any);
        });
      },
    },
  });
  let html = "";
  try {
    const doFetch = opts?.fetchImpl ?? ((input: any, init: any) => undiciFetch(input, { ...init, dispatcher: pinnedDispatcher! }) as unknown as Promise<Response>);
    const response = await doFetch(parsedUrl.toString(), {
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      try {
        if (maxBodyBytes === 0) {
          await reader.cancel().catch(() => undefined);
          controller.abort();
        }
        while (totalBytes < maxBodyBytes) {
          const { done, value } = await reader.read();
          if (done) break;
          const remaining = maxBodyBytes - totalBytes;
          const chunk = value.subarray(0, remaining);
          if (chunk.length) {
            chunks.push(chunk);
            totalBytes += chunk.length;
          }
          if (value.length >= remaining || totalBytes >= maxBodyBytes) {
            await reader.cancel().catch(() => undefined);
            controller.abort();
            break;
          }
        }
      } finally {
        reader.releaseLock();
      }
      const body = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
      html = new TextDecoder().decode(body);
    }
  } catch {
    return { error: controller.signal.aborted ? "request_timeout" : "fetch_failed" };
  } finally {
    clearTimeout(timeout);
    if (pinnedDispatcher) await pinnedDispatcher.close().catch(() => undefined);
  }

  const jsonLdTypes = extractJsonLdTypes(html);
  const titleTokens = extractTitleTokens(html);
  const metaTokens = extractMetaTokens(html);
  const keywordSource = [
    stripTags(html),
    html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? "",
    extractMetaText(html),
  ].join(" ");
  const detected = extractKeywordTokens(keywordSource);
  const serviceTokens = detected.filter((token) =>
    ["service", "services", "menu", "appointment", "booking"].includes(token),
  );
  const categoryTokens = detected.filter((token) =>
    ["spa", "dental", "repair", "restaurant", "clinic", "salon"].includes(token),
  );
  const pageType = recognizedPageType(jsonLdTypes);
  const titleText = extractTitleText(html);
  const metaDescription = extractMetaDescription(html);
  const headings = extractHeadings(html);
  const hashInput = { jsonLdTypes, titleTokens, metaTokens, serviceTokens, categoryTokens, pageType, titleText, metaDescription, headings };
  return {
    sourceUrl: parsedUrl.toString(),
    pageType,
    jsonLdTypes,
    titleTokens,
    metaTokens,
    serviceTokens,
    categoryTokens,
    titleText,
    metaDescription,
    headings,
    capturedAt: new Date().toISOString(),
    contentHash: contentHashOf(hashInput),
  };
}

export function contentHashOf(
  evidence: Omit<WebsiteClassificationEvidence, "contentHash" | "capturedAt" | "sourceUrl">,
): string {
  const canonical: Record<string, unknown> = {
    jsonLdTypes: [...evidence.jsonLdTypes].sort(),
    titleTokens: [...evidence.titleTokens].sort(),
    metaTokens: [...evidence.metaTokens].sort(),
    serviceTokens: [...evidence.serviceTokens].sort(),
    categoryTokens: [...evidence.categoryTokens].sort(),
    pageType: evidence.pageType,
  };
  // The retained description text is part of the fingerprint only when present, so evidence that
  // never carried it keeps the hash it always had while any retained description change is a
  // changed fingerprint that the classification cache must not reuse.
  if (evidence.titleText) canonical.titleText = evidence.titleText;
  if (evidence.metaDescription) canonical.metaDescription = evidence.metaDescription;
  if (evidence.headings && evidence.headings.length > 0) canonical.headings = [...evidence.headings].sort();
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function resolveHostname(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname];
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
}

function isBlockedAddress(address: string): boolean {
  const ipVersion = isIP(address);
  if (!ipVersion) return true;
  if (ipVersion === 4) {
    const octets = address.split(".").map(Number);
    const [a, b, c] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }

  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    if (isIP(mapped) === 4) return isBlockedAddress(mapped);
    const pieces = mapped.split(":");
    if (pieces.length === 2 && pieces.every((part) => /^[0-9a-f]{1,4}$/.test(part))) {
      const high = parseInt(pieces[0], 16);
      const low = parseInt(pieces[1], 16);
      return isBlockedAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
  }
  const first = Number.parseInt(normalized.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // unique-local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xff00) === 0xff00 || // multicast
    (first & 0xe000) === 0x2000 && normalized.startsWith("2001:db8:") // documentation/reserved
  );
}

function extractJsonLdTypes(html: string): string[] {
  const types = new Set<string>();
  const scriptRegex = /<script\b(?=[^>]*\btype\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json))[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(html))) {
    try {
      collectTypes(JSON.parse(match[1]), types);
    } catch {
      // Malformed JSON-LD is ignored; the rest of the page remains usable.
    }
  }
  return [...types];
}

function collectTypes(value: unknown, types: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectTypes(item, types));
  } else if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const type = object["@type"];
    for (const entry of Array.isArray(type) ? type : [type]) {
      if (typeof entry === "string" && entry.trim()) types.add(entry.trim());
    }
    Object.values(object).forEach((item) => collectTypes(item, types));
  }
}

function extractTitleTokens(html: string): string[] {
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? "";
  return tokenize(decodeEntities(stripTags(title)), 40);
}

function extractMetaTokens(html: string): string[] {
  return tokenize(decodeEntities(extractMetaText(html)), 40);
}

const TITLE_TEXT_MAX = 160;
const META_DESCRIPTION_MAX = 300;
const HEADING_MAX = 120;
const HEADINGS_MAX = 12;

function collapseText(value: string, max: number): string {
  return decodeEntities(stripTags(value)).replace(/\s+/g, " ").trim().slice(0, max);
}

function extractTitleText(html: string): string {
  return collapseText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? "", TITLE_TEXT_MAX);
}

function extractMetaDescription(html: string): string {
  const metaRegex = /<meta\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = metaRegex.exec(html))) {
    const attrs = parseAttributes(match[1]);
    if ((attrs.name ?? "").toLowerCase() === "description" && attrs.content) {
      return collapseText(attrs.content, META_DESCRIPTION_MAX);
    }
  }
  return "";
}

function extractHeadings(html: string): string[] {
  const headings: string[] = [];
  const headingRegex = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(html)) && headings.length < HEADINGS_MAX) {
    const text = collapseText(match[2], HEADING_MAX);
    if (text && !headings.includes(text)) headings.push(text);
  }
  return headings;
}

function extractMetaText(html: string): string {
  const values: string[] = [];
  const metaRegex = /<meta\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = metaRegex.exec(html))) {
    const attrs = parseAttributes(match[1]);
    const name = (attrs.name ?? "").toLowerCase();
    if (name === "description" || name === "keywords") values.push(attrs.content ?? "");
  }
  return values.join(" ");
}

function parseAttributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  return attrs;
}

function tokenize(text: string, cap: number): string[] {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(tokens)].slice(0, cap);
}

function extractKeywordTokens(text: string): string[] {
  const candidates = tokenize(decodeEntities(text), Number.MAX_SAFE_INTEGER);
  const keywords = new Set([
    "service", "services", "menu", "appointment", "booking",
    "spa", "dental", "repair", "restaurant", "clinic", "salon",
  ]);
  return candidates.filter((token) => keywords.has(token));
}

function stripTags(value: string): string {
  return value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function recognizedPageType(types: string[]): string {
  const recognized = types.find((type) =>
    /^(?:https?:\/\/schema\.org\/)?(?:localbusiness|organization|corporation|professionalservice|medicalbusiness|dentist|restaurant|store|healthandbeautybusiness|automotivebusiness|legalservice|accountingservice)$/i.test(type),
  );
  return recognized ?? "unknown";
}