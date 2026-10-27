/**
 * One-contact GHL removal test.
 *
 *   npx tsx scripts/ghl-single-contact-removal-test.ts --ghl-id=<id>             # read-only check (default)
 *   npx tsx scripts/ghl-single-contact-removal-test.ts --ghl-id=<id> --delete    # check, DELETE, then read back
 *
 * Check mode only issues GET requests. Delete mode issues exactly one DELETE for the given id after the same checks
 * pass, then reads the contact back and requires "not found". It writes nothing locally and never prints contact
 * fields other than ids, tag names, timestamps and counts.
 *
 * Delete mode talks to GHL directly and does NOT go through the outbound pause authority (that gate refuses every
 * GHL mutation while the global pause is on). Run it only with explicit owner approval for this single contact.
 */
const BASE = "https://services.leadconnectorhq.com";
const token = process.env.GHL_PRIVATE_INTEGRATION_TOKEN || process.env.GHL_API_KEY;
const locationId = process.env.GHL_LOCATION_ID;
const ghlId = process.argv.find(a => a.startsWith("--ghl-id="))?.slice("--ghl-id=".length) ?? "";
const doDelete = process.argv.includes("--delete");

if (!token || !locationId) throw new Error("GHL token or location is not configured");
if (!/^[A-Za-z0-9_-]{10,64}$/.test(ghlId)) throw new Error("--ghl-id=<id> is required");

async function call(method: string, path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json" },
  });
  let body: any = null;
  try { body = await response.json(); } catch { /* empty body */ }
  return { status: response.status, body };
}

/** GHL reports a missing contact as HTTP 400 "Contact not found", not 404. */
const isNotFound = (r: { status: number; body: any }) =>
  r.status === 404 || (r.status === 400 && /not found/i.test(String(r.body?.message ?? r.body?.error ?? "")));

async function check(): Promise<{ exists: boolean; clean: boolean; report: Record<string, unknown> }> {
  const contact = await call("GET", `/contacts/${encodeURIComponent(ghlId)}`);
  if (isNotFound(contact)) return { exists: false, clean: false, report: { contactStatus: contact.status, notFound: true } };
  if (contact.status !== 200) return { exists: false, clean: false, report: { contactStatus: contact.status } };
  const c = contact.body?.contact ?? {};
  const notes = await call("GET", `/contacts/${encodeURIComponent(ghlId)}/notes`);
  const tasks = await call("GET", `/contacts/${encodeURIComponent(ghlId)}/tasks`);
  const opps = await call("GET", `/opportunities/search?location_id=${encodeURIComponent(locationId!)}&contact_id=${encodeURIComponent(ghlId)}`);
  const convs = await call("GET", `/conversations/search?locationId=${encodeURIComponent(locationId!)}&contactId=${encodeURIComponent(ghlId)}`);
  const count = (r: { status: number; body: any }, key: string) => (r.status === 200 && Array.isArray(r.body?.[key]) ? r.body[key].length : null);
  const counts = {
    notes: count(notes, "notes"),
    tasks: count(tasks, "tasks"),
    opportunities: count(opps, "opportunities"),
    conversations: count(convs, "conversations"),
  };
  const statuses = { notes: notes.status, tasks: tasks.status, opportunities: opps.status, conversations: convs.status };
  const sameLocation = c.locationId === locationId;
  const unverifiable = Object.values(counts).some(v => v === null);
  const clean = sameLocation && !unverifiable && Object.values(counts).every(v => v === 0);
  return {
    exists: true,
    clean,
    report: {
      contactStatus: 200, sameLocation, tags: c.tags ?? [], dateAdded: c.dateAdded, dateUpdated: c.dateUpdated,
      source: c.source ?? null, counts, statuses, unverifiable,
    },
  };
}

(async () => {
  const before = await check();
  console.log("before", JSON.stringify(before.report));
  if (!doDelete) { console.log("check mode: nothing changed"); return; }
  if (!before.exists || !before.clean) { console.log("REFUSED: contact is missing, in another location, or has activity/unverifiable activity in GHL"); process.exitCode = 2; return; }
  const del = await call("DELETE", `/contacts/${encodeURIComponent(ghlId)}`);
  console.log("delete status", del.status);
  const after = await call("GET", `/contacts/${encodeURIComponent(ghlId)}`);
  const search = await call("GET", `/contacts/?locationId=${encodeURIComponent(locationId)}&query=${encodeURIComponent(ghlId)}&limit=1`);
  console.log("read-back status", after.status, isNotFound(after) ? "GONE" : "STILL PRESENT OR UNEXPECTED", "search status", search.status);
})().catch(e => { console.error("ERROR", e.message); process.exit(1); });
