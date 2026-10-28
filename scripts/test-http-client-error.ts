/**
 * Real-socket test for handleHttpClientError: malformed and truncated HTTP
 * requests get a closed 400 (or a clean destroy) and valid requests still work.
 *
 * Run: npx tsx scripts/test-http-client-error.ts
 */
import http from "node:http";
import net from "node:net";
import { handleHttpClientError } from "../server/lib/http-client-error";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function raw(port: number, payload: string, halfClose: boolean): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const s = net.connect(port, "127.0.0.1", () => {
      s.write(payload);
      if (halfClose) s.end();
    });
    s.on("data", (c) => chunks.push(c));
    s.on("close", () => resolve(Buffer.concat(chunks).toString()));
    s.on("error", () => resolve(Buffer.concat(chunks).toString()));
    setTimeout(() => s.destroy(), 3000);
  });
}

async function main() {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.join(" ")); };

  const server = http.createServer((_req, res) => { res.end("ok"); });
  server.on("clientError", handleHttpClientError);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;

  const good = await raw(port, "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", false);
  check("valid request still served", good.startsWith("HTTP/1.1 200") && good.endsWith("ok"));

  const garbage = await raw(port, "\x16\x03\x01garbage not http\r\n\r\n", false);
  check("malformed request gets a 400", garbage.startsWith("HTTP/1.1 400"), garbage.split("\r\n")[0]);

  const truncated = await raw(port, "GET /partial HTTP/1.1\r\nHost: x\r\nContent-Le", true);
  check("truncated request closes without a 5xx", !/HTTP\/1\.1 5\d\d/.test(truncated), JSON.stringify(truncated.slice(0, 40)));

  for (let i = 0; i < 5; i++) await raw(port, "BAD\r\n\r\n", false);
  const summaries = warnings.filter((w) => w.includes("Rejected malformed client request"));
  check("log lines are rate limited", summaries.length === 1, `${summaries.length} lines`);

  const after = await raw(port, "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", false);
  check("server healthy after bad connections", after.startsWith("HTTP/1.1 200"));

  console.warn = origWarn;
  server.close();
  if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
  console.log("All checks passed");
}

main();
