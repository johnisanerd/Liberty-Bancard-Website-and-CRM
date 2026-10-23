/**
 * safe-fetch.ts — SSRF-safe fetch helper for the free enrichment pipeline.
 *
 * Security model:
 *   1. DNS is resolved once; the resulting IP is validated; the TCP connection
 *      is made to that exact IP (not re-resolved). This eliminates the TOCTOU
 *      DNS-rebinding window that exists when validating before a standard `fetch`.
 *   2. Redirect targets must resolve to a safe IP and must be the same hostname
 *      or a subdomain of the request origin (no cross-domain redirect following).
 *   3. The abort timer remains active through the entire body read — response
 *      headers receipt does not stop the clock.
 *   4. Response body is capped at `maxBytes` (default 5 MB).
 *   5. Per-domain rate limiting: 1 request/second shared across callers.
 *   6. Unified user-agent: LibertyBancardBot/1.0
 *
 * All MI-04 enrichment modules use this helper exclusively.
 * No paid providers (Serper, Apollo, Outscraper, ZeroBounce) are ever called.
 */

import { promises as dnsPromises } from "dns";
import https from "https";
import http from "http";
import type { IncomingMessage } from "http";

const USER_AGENT = "Mozilla/5.0 (compatible; LibertyBancardBot/1.0)";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_REDIRECTS = 5;

// Per-domain rate limiter: promise-chain serializer, concurrency-safe.
// Each call chains on the previous call's promise for the same hostname.
// This guarantees that concurrent BullMQ workers processing the same hostname
// are serialized with at least DOMAIN_RATE_LIMIT_MS between requests — no
// timestamp-read race is possible because the sequencing is structural.
const _domainQueues = new Map<string, Promise<void>>();
const DOMAIN_RATE_LIMIT_MS = 1_000;

async function domainRateLimit(hostname: string): Promise<void> {
  const key = hostname.toLowerCase();
  const prev = _domainQueues.get(key) ?? Promise.resolve();

  // My slot: wait for the previous caller to finish, then wait DOMAIN_RATE_LIMIT_MS
  const mySlot = prev.then(() => new Promise<void>(r => setTimeout(r, DOMAIN_RATE_LIMIT_MS)));
  // Register this slot as the new tail of the queue for this hostname
  _domainQueues.set(key, mySlot.catch(() => {})); // swallow so later callers can proceed
  await mySlot;
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost", "metadata.google.internal", "169.254.169.254",
]);

const PRIVATE_IPV4 = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

const PRIVATE_IPV6 = [
  // Loopback
  /^::1$/i,
  // Unspecified
  /^::$/i,
  // Unique local (fc00::/7 — covers fc00::/8 and fd00::/8)
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
  // Link-local (fe80::/10 — fe80–febf)
  /^fe[89ab][0-9a-f]:/i,
  // IPv4-mapped IPv6 (::ffff:0:0/96) — covers ::ffff:127.x, ::ffff:10.x, etc.
  // After normalizing, these appear as ::ffff:x.x.x.x or as pure hex segments.
  /^::ffff:/i,
  /^::ffff:0:/i,
  // Discard prefix (100::/64)
  /^0100:/i,
  // Documentation/example ranges (2001:db8::/32)
  /^2001:db8:/i,
];

function isPrivateIp(addr: string): boolean {
  return (
    PRIVATE_IPV4.some(r => r.test(addr)) ||
    PRIVATE_IPV6.some(r => r.test(addr))
  );
}

/**
 * Resolve a hostname to its first non-private IPv4 address.
 * Returns the validated IP, or null if none is safe.
 */
async function resolveSafeIp(hostname: string): Promise<{ ip: string; family: 4 | 6 } | null> {
  const lower = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(lower)) return null;

  // If it's already an IP address, validate directly
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return isPrivateIp(hostname) ? null : { ip: hostname, family: 4 };
  }
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const raw = hostname.slice(1, -1);
    return isPrivateIp(raw) ? null : { ip: raw, family: 6 };
  }

  const [v4addrs, v6addrs] = await Promise.all([
    dnsPromises.resolve4(hostname).catch(() => [] as string[]),
    dnsPromises.resolve6(hostname).catch(() => [] as string[]),
  ]);

  // Prefer IPv4 for compatibility
  for (const ip of v4addrs) {
    if (!isPrivateIp(ip)) return { ip, family: 4 };
  }
  for (const ip of v6addrs) {
    if (!isPrivateIp(ip)) return { ip, family: 6 };
  }
  return null;
}

/**
 * Check that `redirectHostname` is the same as or a subdomain of `originHostname`.
 * This avoids the public-suffix-list complexity entirely by being more conservative.
 */
function isAllowedRedirectHost(originHostname: string, redirectHostname: string): boolean {
  const o = originHostname.toLowerCase();
  const r = redirectHostname.toLowerCase();
  return r === o || r.endsWith("." + o);
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  method?: string;
  headers?: Record<string, string>;
}

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  url: string;
  /** Body text, eagerly read with the same abort timer. Null when timed out. */
  body: string | null;
  text: () => Promise<string | null>;
}

/**
 * Makes an HTTP/HTTPS request to `rawUrl` with:
 *   - DNS resolved → IP validated → TCP connected to pinned IP (no TOCTOU)
 *   - Redirect following restricted to same-host-or-subdomain
 *   - Abort timer active through body consumption
 *   - Response body capped at `maxBytes`
 *
 * Returns null if the request is blocked (SSRF), fails, or times out.
 */
export async function safeFetch(
  rawUrl: string,
  opts: SafeFetchOptions = {}
): Promise<SafeFetchResult | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;
  const method = (opts.method ?? "GET").toUpperCase();

  let currentUrl: URL;
  try {
    currentUrl = new URL(rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(currentUrl.protocol)) return null;

  const originHostname = currentUrl.hostname;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const hostname = currentUrl.hostname;
    const protocol = currentUrl.protocol;
    const port = currentUrl.port
      ? Number(currentUrl.port)
      : protocol === "https:" ? 443 : 80;
    const path = currentUrl.pathname + currentUrl.search;

    // Resolve DNS → validate → pin the IP before connecting
    const resolved = await resolveSafeIp(hostname);
    if (!resolved) {
      console.info(`[SafeFetch] SSRF blocked: ${hostname} (unresolvable or private)`);
      return null;
    }

    // Rate limit per hostname (not per IP, to stay within service terms)
    await domainRateLimit(hostname);

    // Make the request directly to the pinned IP with the correct Host/SNI headers.
    // We use Node's http/https module (not global fetch) so we can control the
    // TCP connection target independently of the DNS lookup.
    const response = await new Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: Promise<string | null> } | null>((resolve) => {
      // Single abort timer that covers both headers AND body read.
      const aborted = { value: false };
      const timer = setTimeout(() => {
        aborted.value = true;
        req.destroy(new Error("SafeFetch timeout"));
        console.info(`[SafeFetch] Timeout: ${currentUrl.href}`);
        resolve(null);
      }, timeoutMs);

      const requestOptions: https.RequestOptions = {
        method,
        host: resolved.ip,
        port,
        path,
        headers: {
          "Host": hostname,
          "User-Agent": USER_AGENT,
          "Accept": "text/html,application/xhtml+xml,application/json",
          ...(opts.headers ?? {}),
        },
        servername: hostname, // TLS SNI uses original hostname, not IP
        rejectUnauthorized: true,
      };

      const transport = protocol === "https:" ? https : http;
      const req = transport.request(requestOptions, (res: IncomingMessage) => {
        const statusCode = res.statusCode ?? 0;
        const headers: Record<string, string | string[] | undefined> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          headers[k.toLowerCase()] = v;
        }

        if (aborted.value) return;

        // Collect body eagerly under the same abort timer.
        // The body promise resolves to null when the timer fires (aborted.value=true),
        // so callers never see a partial-body success from a timed-out connection.
        const bodyPromise = new Promise<string | null>((resolveBod) => {
          const chunks: Buffer[] = [];
          let total = 0;
          let done = false;

          const finish = (text: string | null) => {
            if (!done) {
              done = true;
              clearTimeout(timer);
              resolveBod(text);
            }
          };

          res.on("data", (chunk: Buffer) => {
            if (aborted.value) { finish(null); return; }
            const remaining = maxBytes - total;
            if (chunk.byteLength <= remaining) {
              chunks.push(chunk);
              total += chunk.byteLength;
            } else {
              // Cap: take only the remaining bytes and destroy the stream
              chunks.push(chunk.subarray(0, remaining));
              total += remaining;
              res.destroy();
              finish(Buffer.concat(chunks).toString("utf8"));
            }
          });
          res.on("end", () => {
            if (aborted.value) { finish(null); return; }
            finish(Buffer.concat(chunks).toString("utf8"));
          });
          // On error (including req.destroy() after timeout), resolve null if aborted.
          res.on("error", () => {
            finish(aborted.value ? null : Buffer.concat(chunks).toString("utf8"));
          });
        });

        resolve({ statusCode, headers, body: bodyPromise });
      });

      req.on("error", (err: Error) => {
        if (!aborted.value) {
          clearTimeout(timer);
          resolve(null);
        }
      });

      req.end();
    });

    if (!response) return null;

    // Follow redirects (manual)
    if (response.statusCode >= 300 && response.statusCode < 400) {
      if (redirectCount >= MAX_REDIRECTS) {
        console.info(`[SafeFetch] Max redirects reached for ${originHostname}`);
        return null;
      }

      const locationRaw = response.headers["location"];
      const location = Array.isArray(locationRaw) ? locationRaw[0] : locationRaw;
      if (!location) return null;

      let locationUrl: URL;
      try {
        locationUrl = new URL(location, currentUrl.href);
      } catch {
        return null;
      }
      if (!["http:", "https:"].includes(locationUrl.protocol)) return null;

      // Redirect must stay on same host or subdomain (avoids PSL complexity)
      if (!isAllowedRedirectHost(originHostname, locationUrl.hostname)) {
        console.info(
          `[SafeFetch] Blocked cross-origin redirect: ${currentUrl.href} → ${locationUrl.href}`
        );
        return null;
      }

      currentUrl = locationUrl;
      continue;
    }

    // Eagerly await the body under the same abort timer before returning.
    // If the timer fired during body read, body resolves to null → we return null
    // from safeFetch so callers observe the same transport-failure signal as a
    // connection timeout. Callers that call resp.text() see the same null body.
    const bodyText = await response.body;
    if (bodyText === null) {
      // Timer fired during body read — treat as transport failure
      return null;
    }

    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      url: currentUrl.href,
      body: bodyText,
      text: () => Promise.resolve(bodyText),
    };
  }

  return null;
}
