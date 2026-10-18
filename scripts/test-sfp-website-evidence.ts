#!/usr/bin/env npx tsx
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extractWebsiteClassificationEvidence } from "../server/services/cro03/sfp-website-evidence";

let passed = 0;
const server = createServer((request, response) => {
  if (request.url === "/fixture") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixtureHtml);
    return;
  }
  if (request.url === "/large") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "transfer-encoding": "chunked",
    });
    const pieces = [`<title>Large Dental Services</title>${"x".repeat(32)}`];
    const remainingBytes = 300_000;
    let sent = 0;
    let closedEarly = false;
    response.on("close", () => {
      if (sent < remainingBytes) closedEarly = true;
    });
    const sendNext = () => {
      if (response.destroyed) return;
      if (sent >= remainingBytes) {
        response.end();
        return;
      }
      const chunk = "z".repeat(Math.min(1024, remainingBytes - sent));
      sent += Buffer.byteLength(chunk);
      response.write(chunk);
      setTimeout(sendNext, 1);
    };
    response.write(pieces[0]);
    setTimeout(sendNext, 1);
    response.on("close", () => {
      if (closedEarly) server.emit("large-response-closed-early");
    });
    return;
  }
  response.writeHead(404).end();
});

const fixtureHtml = `<!doctype html>
<html><head>
  <title>Miami Dental &amp; Spa Services</title>
  <meta name="description" content="Dental appointment booking and clinic services">
  <meta content="salon menu" name="keywords">
  <script type="application/ld+json">{"@context":"https://schema.org","@type":["LocalBusiness","Dentist"]}</script>
</head><body><h1>Dental clinic appointments and spa services</h1><p>UNIQUE_RAW_BODY_MARKER_7F31</p></body></html>`;

async function run() {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const resolveLocalhost = async () => "8.8.8.8";
  const fetchLocal: typeof fetch = (input, init) => {
    const requestUrl = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    return fetch(`${baseUrl}${requestUrl.pathname}${requestUrl.search}`, init);
  };
  try {
    console.log("[1] Fixture extraction, determinism, and raw-body exclusion");
    const first = await extractWebsiteClassificationEvidence("http://evidence.test/fixture", {
      resolveImpl: resolveLocalhost,
      fetchImpl: fetchLocal,
    });
    const second = await extractWebsiteClassificationEvidence("http://evidence.test/fixture", {
      resolveImpl: resolveLocalhost,
      fetchImpl: fetchLocal,
    });
    assert.ok(!("error" in first));
    assert.ok(!("error" in second));
    assert.deepEqual(first.jsonLdTypes, ["LocalBusiness", "Dentist"]);
    assert.deepEqual(first.titleTokens, ["miami", "dental", "spa", "services"]);
    assert.deepEqual(first.metaTokens, [
      "dental", "appointment", "booking", "and", "clinic", "services", "salon", "menu",
    ]);
    assert.deepEqual(first.serviceTokens, ["services", "appointment", "booking", "menu"]);
    assert.deepEqual(first.categoryTokens, ["dental", "spa", "clinic", "salon"]);
    assert.equal(first.pageType, "LocalBusiness");
    assert.equal(first.contentHash, second.contentHash);
    assert.ok(
      Object.values(first).every(
        (value) => typeof value !== "string" || !value.includes("UNIQUE_RAW_BODY_MARKER_7F31"),
      ),
    );
    pass("JSON-LD/title/meta/service/category extraction is correct and deterministic; raw HTML marker is absent");

    console.log("\n[2] Bounded body read aborts the oversized response");
    const earlyClose = new Promise<void>((resolve) => {
      server.once("large-response-closed-early", () => resolve());
    });
    const large = await extractWebsiteClassificationEvidence("http://evidence.test/large", {
      resolveImpl: resolveLocalhost,
      fetchImpl: fetchLocal,
      maxBodyBytes: 128,
      timeoutMs: 3_000,
    });
    assert.ok(!("error" in large));
    await Promise.race([
      earlyClose,
      new Promise((_, reject) => setTimeout(() => reject(new Error("large response was not aborted")), 3_000)),
    ]);
    assert.deepEqual(large.titleTokens, ["large", "dental", "services"]);
    pass("The oversized response connection closes early after the configured 128-byte cap");

    console.log("\n[3] Private target is rejected before the fetch implementation");
    let privateFetchCalls = 0;
    const privateResult = await extractWebsiteClassificationEvidence("http://private-evidence.invalid/", {
      resolveImpl: async () => "10.23.4.5",
      fetchImpl: async () => {
        privateFetchCalls++;
        throw new Error("fetch must not be reached");
      },
    });
    assert.deepEqual(privateResult, { error: "blocked_private_target" });
    assert.equal(privateFetchCalls, 0);
    pass("Resolved private IPv4 target is blocked before HTTP fetch");

    console.log("\n[4] Non-HTTP protocol is rejected without network access");
    let protocolFetchCalls = 0;
    const protocolResult = await extractWebsiteClassificationEvidence("file:///etc/passwd", {
      fetchImpl: async () => {
        protocolFetchCalls++;
        throw new Error("fetch must not be reached");
      },
    });
    assert.deepEqual(protocolResult, { error: "unsupported_protocol" });
    assert.equal(protocolFetchCalls, 0);
    pass("file:// is rejected before DNS or fetch");

    console.log("\n[5] Redirects, statuses, and paragraph-only services");
    const html = (inner: string, head = "<title>Home</title>") => `<html><head>${head}</head><body>${inner}</body></html>`;
    const respond = (status: number, body = "", headers: Record<string, string> = {}) =>
      new Response(body || null, { status, headers: { "content-type": "text/html", ...headers } });
    const publicResolve = async (host: string) => (host.startsWith("internal") ? "10.0.0.8" : "93.184.216.34");
    const fake = (routes: Record<string, () => Response>, seen: string[] = []) => (async (input: any) => {
      seen.push(String(input));
      const route = routes[String(input)];
      if (!route) throw new Error(`unexpected ${input}`);
      return route();
    }) as unknown as typeof fetch;
    const paragraphPage = html(
      "<nav><p>Home about us contact blog careers</p></nav><main><p>We provide comprehensive family dentistry, teeth whitening and orthodontic care for patients of all ages.</p><p>Short.</p><p>We use cookies to improve your experience on this website today.</p></main><footer><p>Copyright 2026 all rights reserved by owner</p></footer>");

    const hops: string[] = [];
    const viaWww = await extractWebsiteClassificationEvidence("https://example-dental.test/", {
      resolveImpl: publicResolve,
      fetchImpl: fake({
        "https://example-dental.test/": () => respond(301, "", { location: "https://www.example-dental.test/" }),
        "https://www.example-dental.test/": () => respond(200, paragraphPage),
      }, hops),
    });
    assert.ok(!("error" in viaWww));
    assert.equal(viaWww.sourceUrl, "https://example-dental.test/");
    assert.equal(viaWww.finalUrl, "https://www.example-dental.test/");
    assert.deepEqual(viaWww.serviceDescriptions, [
      "We provide comprehensive family dentistry, teeth whitening and orthodontic care for patients of all ages.",
    ]);
    assert.equal(hops.length, 2);
    pass("A redirect to the www host is followed; navigation, footer, cookie and one-word paragraphs are excluded; paragraph-only services are retained");

    assert.deepEqual(await extractWebsiteClassificationEvidence("https://r.test/", {
      resolveImpl: publicResolve,
      fetchImpl: fake({ "https://r.test/": () => respond(302, "", { location: "http://internal.test/admin" }) }),
    }), { error: "redirect_blocked_private_target" });
    assert.deepEqual(await extractWebsiteClassificationEvidence("https://r.test/", {
      resolveImpl: publicResolve,
      fetchImpl: fake({ "https://r.test/": () => respond(302, "", { location: "ftp://r.test/x" }) }),
    }), { error: "redirect_unsupported_protocol" });
    pass("A redirect to a private or non-HTTP target is rejected before it is fetched");

    assert.deepEqual(await extractWebsiteClassificationEvidence("https://loop.test/a", {
      resolveImpl: publicResolve,
      fetchImpl: fake({
        "https://loop.test/a": () => respond(302, "", { location: "/b" }),
        "https://loop.test/b": () => respond(302, "", { location: "/a" }),
      }),
    }), { error: "redirect_loop" });
    let chain = 0;
    const endless = (async (input: any) => respond(302, "", { location: `/p${++chain}` })) as unknown as typeof fetch;
    assert.deepEqual(await extractWebsiteClassificationEvidence("https://loop.test/", { resolveImpl: publicResolve, fetchImpl: endless }),
      { error: "too_many_redirects" });
    assert.deepEqual(await extractWebsiteClassificationEvidence("https://loop.test/", {
      resolveImpl: publicResolve, fetchImpl: fake({ "https://loop.test/": () => respond(301) }) }), { error: "redirect_failed" });
    pass("Redirect loops, endless chains and a redirect without a location are errors");

    for (const status of [403, 404, 500, 503]) {
      assert.deepEqual(await extractWebsiteClassificationEvidence("https://s.test/", {
        resolveImpl: publicResolve, fetchImpl: fake({ "https://s.test/": () => respond(status, html("<p>We provide family dentistry for the whole community.</p>")) }),
      }), { error: `http_${status}` });
    }
    assert.deepEqual(await extractWebsiteClassificationEvidence("https://s.test/", {
      resolveImpl: publicResolve, fetchImpl: fake({ "https://s.test/": () => respond(200, "   ") }) }), { error: "empty_response" });
    assert.deepEqual(await extractWebsiteClassificationEvidence("https://s.test/", {
      resolveImpl: publicResolve, fetchImpl: fake({ "https://s.test/": () => respond(200, "%PDF", { "content-type": "application/pdf" }) }) }),
      { error: "unsupported_content_type" });
    assert.deepEqual(await extractWebsiteClassificationEvidence("https://s.test/", {
      resolveImpl: publicResolve,
      fetchImpl: fake({ "https://s.test/": () => respond(200, html("<p>Please wait while we verify.</p>", "<title>Just a moment...</title>")) }),
    }), { error: "challenge_page" });
    pass("Non-2xx pages, empty bodies, non-HTML and bot-challenge pages are errors, never empty evidence");

    const positive = await extractWebsiteClassificationEvidence("https://ok.test/", {
      resolveImpl: publicResolve,
      fetchImpl: fake({ "https://ok.test/": () => respond(200, html("<h1>Bright Smile Dental</h1>", "<title>Bright Smile Dental</title>")) }),
    });
    assert.ok(!("error" in positive) && positive.headings?.[0] === "Bright Smile Dental" && (positive.serviceDescriptions ?? []).length === 0);
    const withParagraph = await extractWebsiteClassificationEvidence("https://ok.test/", {
      resolveImpl: publicResolve,
      fetchImpl: fake({ "https://ok.test/": () => respond(200, html("<h1>Bright Smile Dental</h1><p>We provide family dentistry and teeth whitening in Miami.</p>", "<title>Bright Smile Dental</title>")) }),
    });
    assert.ok(!("error" in withParagraph) && !("error" in positive) && withParagraph.contentHash !== positive.contentHash);
    pass("A positive page keeps the evidence it always had; added paragraph text changes the content fingerprint");

    console.log(`\n${passed} assertions passed; 0 failed.`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function pass(label: string) {
  console.log(`  ✓ ${label}`);
  passed++;
}

run().catch((error) => {
  console.error("  ✗ FAIL:", error);
  process.exitCode = 1;
});