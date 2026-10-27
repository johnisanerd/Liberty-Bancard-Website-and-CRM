/**
 * READ-ONLY existence check of the contacts the GHL sync created.
 *
 *   npx tsx scripts/ghl-created-contact-existence-check.ts [--limit=N]
 *
 * Input:  generated-artifacts/ghl-created-contacts.json   [{ id, ghlId, held }]
 * Output: generated-artifacts/ghl-created-contacts-existence.json   { [ghlId]: "present" | "missing" | "other_location" | "error:<status>" }
 *
 * Issues only GET /contacts/:id. Resumable (skips ids already resolved), paced under GHL's rate limit, and backs off
 * on 429. GHL reports a missing contact as HTTP 400 "Contact not found". Prints counts only, never contact fields.
 */
import fs from "fs";

const BASE = "https://services.leadconnectorhq.com";
const IN = "generated-artifacts/ghl-created-contacts.json";
const OUT = "generated-artifacts/ghl-created-contacts-existence.json";
const token = process.env.GHL_PRIVATE_INTEGRATION_TOKEN || process.env.GHL_API_KEY;
const locationId = process.env.GHL_LOCATION_ID;
if (!token || !locationId) throw new Error("GHL token or location is not configured");
const limit = Number(process.argv.find(a => a.startsWith("--limit="))?.slice(8) ?? "0") || Infinity;

const rows: Array<{ id: number; ghlId: string; held: boolean }> = JSON.parse(fs.readFileSync(IN, "utf8"));
const results: Record<string, string> = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function lookup(ghlId: string): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(`${BASE}/contacts/${encodeURIComponent(ghlId)}`, {
      headers: { Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json" },
    });
    if (response.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    let body: any = null;
    try { body = await response.json(); } catch { /* empty */ }
    if (response.status === 200) return body?.contact?.locationId === locationId ? "present" : "other_location";
    if (response.status === 404 || (response.status === 400 && /not found/i.test(String(body?.message ?? body?.error ?? "")))) return "missing";
    if (response.status >= 500) { await sleep(1000 * (attempt + 1)); continue; }
    return `error:${response.status}`;
  }
  return "error:retries_exhausted";
}

(async () => {
  let done = 0;
  for (const row of rows) {
    if (results[row.ghlId] && !results[row.ghlId].startsWith("error:")) continue;
    if (done >= limit) break;
    results[row.ghlId] = await lookup(row.ghlId);
    done++;
    if (done % 200 === 0) { fs.writeFileSync(OUT, JSON.stringify(results)); console.log(`progress ${done}`); }
    await sleep(110);
  }
  fs.writeFileSync(OUT, JSON.stringify(results));
  const tally: Record<string, number> = {};
  const heldTally: Record<string, number> = {};
  for (const row of rows) {
    const k = results[row.ghlId] ?? "unchecked";
    tally[k] = (tally[k] ?? 0) + 1;
    if (row.held) heldTally[k] = (heldTally[k] ?? 0) + 1;
  }
  console.log("ALL", JSON.stringify(tally));
  console.log("HELD", JSON.stringify(heldTally));
})().catch(e => { console.error("ERROR", e.message); process.exit(1); });
