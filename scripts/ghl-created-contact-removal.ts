/**
 * Capped removal of contacts the GHL sync created (owner-approved). Talks to GHL directly and does NOT use the
 * outbound pause authority, so run it only with explicit owner approval.
 *
 *   npx tsx scripts/ghl-created-contact-removal.ts --limit=250     # process at most N not-yet-resolved contacts
 *   npx tsx scripts/ghl-created-contact-removal.ts                 # process all remaining
 *
 * Inputs (generated-artifacts/): ghl-created-contacts-v2.json [{ id, ghlId, hold }],
 *   ghl-created-contacts-existence.json { [ghlId]: "present" | "missing" | ... }.
 * Ledger: ghl-created-contacts-removal-ledger.json { [ghlId]: result }, written after every contact so runs resume.
 *
 * Per contact: GET contact + notes + tasks + opportunities + conversations. Any activity, other location, or an
 * unverifiable lookup => skipped (never deleted). Otherwise one DELETE, then a read-back that must report not found.
 * Held contacts (human-origin source, deal, local edit) and contacts already missing are never touched.
 * Stops at once on 2 consecutive anomalies (auth failure, non-2xx delete, contact still present after delete).
 * Prints counts only, never contact fields.
 */
import fs from "fs";

const BASE = "https://services.leadconnectorhq.com";
const DIR = "generated-artifacts";
const LEDGER = `${DIR}/ghl-created-contacts-removal-ledger.json`;
const token = process.env.GHL_PRIVATE_INTEGRATION_TOKEN || process.env.GHL_API_KEY;
const locationId = process.env.GHL_LOCATION_ID;
if (!token || !locationId) throw new Error("GHL token or location is not configured");
const limit = Number(process.argv.find(a => a.startsWith("--limit="))?.slice(8) ?? "0") || Infinity;

const rows: Array<{ id: number; ghlId: string; hold: boolean }> = JSON.parse(fs.readFileSync(`${DIR}/ghl-created-contacts-v2.json`, "utf8"));
const existence: Record<string, string> = JSON.parse(fs.readFileSync(`${DIR}/ghl-created-contacts-existence.json`, "utf8"));
const ledger: Record<string, string> = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, "utf8")) : {};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function call(method: string, path: string): Promise<{ status: number; body: any }> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json" },
    });
    if (response.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    let body: any = null;
    try { body = await response.json(); } catch { /* empty */ }
    if (response.status >= 500 && method === "GET") { await sleep(1000 * (attempt + 1)); continue; }
    return { status: response.status, body };
  }
  return { status: 429, body: null };
}
const isNotFound = (r: { status: number; body: any }) =>
  r.status === 404 || (r.status === 400 && /not found/i.test(String(r.body?.message ?? r.body?.error ?? "")));
const listCount = (r: { status: number; body: any }, key: string) => (r.status === 200 && Array.isArray(r.body?.[key]) ? r.body[key].length : null);

async function process_(ghlId: string): Promise<string> {
  const contact = await call("GET", `/contacts/${encodeURIComponent(ghlId)}`);
  if (isNotFound(contact)) return "already_missing";
  if (contact.status !== 200) return `anomaly:get_${contact.status}`;
  if (contact.body?.contact?.locationId !== locationId) return "skipped:other_location";
  const [notes, tasks, opps, convs] = [
    await call("GET", `/contacts/${encodeURIComponent(ghlId)}/notes`),
    await call("GET", `/contacts/${encodeURIComponent(ghlId)}/tasks`),
    await call("GET", `/opportunities/search?location_id=${encodeURIComponent(locationId!)}&contact_id=${encodeURIComponent(ghlId)}`),
    await call("GET", `/conversations/search?locationId=${encodeURIComponent(locationId!)}&contactId=${encodeURIComponent(ghlId)}`),
  ];
  const counts = [listCount(notes, "notes"), listCount(tasks, "tasks"), listCount(opps, "opportunities"), listCount(convs, "conversations")];
  if (counts.some(c => c === null)) return "skipped:unverifiable_activity";
  if (counts.some(c => (c as number) > 0)) return "skipped:has_activity";
  const del = await call("DELETE", `/contacts/${encodeURIComponent(ghlId)}`);
  if (del.status < 200 || del.status >= 300) return `anomaly:delete_${del.status}`;
  const after = await call("GET", `/contacts/${encodeURIComponent(ghlId)}`);
  return isNotFound(after) ? "deleted" : `anomaly:still_present_${after.status}`;
}

(async () => {
  const todo = rows.filter(r => !r.hold && existence[r.ghlId] === "present" && !ledger[r.ghlId]?.match(/^(deleted|already_missing|skipped:)/));
  console.log(`eligible to process: ${todo.length}`);
  let done = 0; let consecutiveAnomalies = 0;
  for (const row of todo) {
    if (done >= limit) break;
    const result = await process_(row.ghlId);
    ledger[row.ghlId] = result;
    done++;
    fs.writeFileSync(LEDGER, JSON.stringify(ledger));
    consecutiveAnomalies = result.startsWith("anomaly:") ? consecutiveAnomalies + 1 : 0;
    if (consecutiveAnomalies >= 2) { console.log("STOPPED: 2 consecutive anomalies"); break; }
    if (done % 100 === 0) console.log(`progress ${done}`);
    await sleep(100);
  }
  const tally: Record<string, number> = {};
  for (const v of Object.values(ledger)) tally[v] = (tally[v] ?? 0) + 1;
  console.log("LEDGER", JSON.stringify(tally));
})().catch(e => { console.error("ERROR", e.message); process.exit(1); });
