import crypto from "node:crypto";
import os from "node:os";
import { eq, or, sql } from "drizzle-orm";
import { db, pool } from "../db";
import { contacts } from "@shared/schema";
import type { GhlInboundSyncCounts, GhlInboundSyncRun, GhlInboundSyncStatus } from "@shared/ghl-inbound-sync";
import { writeContact, updateContactLocalFirst, type ContactWriterHookPolicy } from "./contact-writer";
import { lockContactMailboxes } from "./contact-mailbox-identity";
import { parseGhlInboundCursor } from "./ghl-inbound-pagination";

const PREFIX = "ghl_inbound_contact_sync";
const PAGE_SIZE = 100;
const APPLY_PAGE_SIZE = 20;
const PLAN_PAGE_SIZE = 100;
const MAX_REMOTE_CONTACTS = 50_000;
const MAX_PAGES = Math.ceil(MAX_REMOTE_CONTACTS / PAGE_SIZE);
const LEASE_MS = 2 * 60_000;
const FIELDS = ["firstName", "lastName", "email", "phone", "companyName"] as const;
type SafeSource = { id: string; firstName: string; lastName: string; email: string; phone: string; companyName: string };
type Plan = { source: SafeSource; kind: "create" | "update" | "unchanged" | "conflict" | "skip"; targetId: number | null; fill: Record<string, string>; reason?: string };
type StoredRun = GhlInboundSyncRun & {
  mode: "preview" | "apply";
  phase: "read" | "plan";
  sources: SafeSource[];
  plans: Plan[];
  scanCursor: { startAfter: string; startAfterId: string } | null;
  seenCursors: string[];
  pageCount: number;
  planCursor: number;
  remoteTotal: number | null;
  pauseEpoch: string | null;
  isWebhook: boolean;
  actorId: string;
  applyCursor: number;
  idempotencyKey: string;
  leaseToken: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
};
const EMPTY_COUNTS = (): GhlInboundSyncCounts => ({
  scanned: 0, matched: 0, wouldUpdate: 0, wouldCreate: 0, unchanged: 0,
  conflicts: 0, skipped: 0, updated: 0, created: 0,
});
const hooks: ContactWriterHookPolicy = {
  source: "ghl_inbound", deferValidation: true, deferReadiness: true,
  deferLeadScoring: true, suppressProviderProjection: true,
};
const runKey = (id: string) => `${PREFIX}_run_${id}`;
const safeJson = (v: unknown) => JSON.stringify(v);
const safeOperationalError = (error: unknown) => {
  const message = (error as Error)?.message ?? "";
  return /^[A-Z0-9_:-]{1,120}$/.test(message) ? message : "GHL_INBOUND_INTERNAL_ERROR";
};
const ownerTag = () => `${os.hostname()}:${process.pid}`;
const normalizedEmail = (v: unknown) => String(v ?? "").trim().toLowerCase();
const trimmed = (v: unknown) => String(v ?? "").trim();
const nonblank = (v: unknown) => trimmed(v).length > 0;
const usableEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const usablePhone = (v: string) => {
  const digits = v.match(/\d/g) ?? [];
  return digits.length >= 10 && digits.length <= 15 && /^\+?[\d().\-\s]+$/.test(v);
};
const issue = (run: StoredRun, ghlContactId: string | null, reason: string) => {
  if (run.issues.length < 500) run.issues.push({ ghlContactId, reason });
};
const scalarString = (v: unknown, max: number): string =>
  typeof v === "string" && v.trim().length <= max ? v.trim() : "";

export function sanitizeGhlInboundContact(input: any): SafeSource | null {
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.id !== "string") return null;
  const id = input.id.trim();
  if (!id || id.length > 200) return null;
  const limits: Record<string, number> = { firstName: 200, lastName: 200, email: 320, phone: 64, companyName: 300 };
  for (const [field, limit] of Object.entries(limits)) {
    const value = input[field];
    if (value !== undefined && value !== null && (typeof value !== "string" || value.trim().length > limit)) return null;
  }
  const email = normalizedEmail(scalarString(input.email, 320));
  const phone = scalarString(input.phone, 64);
  return {
    id,
    firstName: scalarString(input.firstName, 200),
    lastName: scalarString(input.lastName, 200),
    email: usableEmail(email) ? email : "",
    phone: usablePhone(phone) ? phone : "",
    companyName: scalarString(input.companyName, 300),
  };
}

async function readSetting<T>(key: string): Promise<T | null> {
  const r = await pool.query<{ value: T }>("SELECT value FROM system_settings WHERE key=$1", [key]);
  return r.rows[0]?.value ?? null;
}
async function writeRunFenced(run: StoredRun, token: string): Promise<void> {
  const result = await pool.query(
    `UPDATE system_settings SET value=$2::jsonb,updated_at=NOW()
     WHERE key=$1 AND value->>'leaseToken'=$3
       AND (value->>'leaseExpiresAt')::timestamptz > NOW()`,
    [runKey(run.runId), safeJson(run), token],
  );
  if (result.rowCount !== 1) throw new Error("GHL_INBOUND_LEASE_LOST");
}
async function readRun(id: string): Promise<StoredRun | null> {
  return readSetting<StoredRun>(runKey(id));
}
function publicRun(run: StoredRun): GhlInboundSyncRun {
  const { runId, state, createdAt, updatedAt, counts, previewHash, nextAction, lastError, issues } = run;
  return { runId, state, createdAt, updatedAt, counts, previewHash, nextAction, lastError, issues };
}
function makeRun(idem: string, actorId: string): StoredRun {
  const now = new Date().toISOString();
  return {
    runId: crypto.randomUUID(), state: "previewing", createdAt: now, updatedAt: now,
    counts: EMPTY_COUNTS(), previewHash: null, nextAction: "scan", lastError: null, issues: [],
    mode: "preview", phase: "read", sources: [], plans: [], scanCursor: null, seenCursors: [], pageCount: 0,
    planCursor: 0, applyCursor: 0, remoteTotal: null, pauseEpoch: null, isWebhook: false, actorId,
    idempotencyKey: idem, leaseToken: null, leaseOwner: null, leaseExpiresAt: null,
  };
}

export async function getGhlInboundSyncStatus(): Promise<GhlInboundSyncStatus> {
  const enabled = await readSetting<boolean>(`${PREFIX}_enabled`);
  let outboundPaused: boolean | null = null;
  try {
    const result = await pool.query<{ state: string }>("SELECT state FROM outbound_pause_control ORDER BY id LIMIT 1");
    outboundPaused = result.rows[0]?.state === "paused";
  } catch { outboundPaused = null; }
  const activeId = await readSetting<string>(`${PREFIX}_active`);
  const stored = activeId ? await readRun(activeId) : null;
  const apiKey = process.env.GHL_PRIVATE_INTEGRATION_TOKEN || process.env.GHL_API_KEY;
  const configured = !!(apiKey && process.env.GHL_LOCATION_ID);
  return {
    environment: process.env.NODE_ENV === "production" ? "production" : "development",
    configured, inboundEnabled: enabled === true, outboundPaused,
    run: stored ? publicRun(stored) : null,
    runtime: {
      asOf: new Date().toISOString(), mode: stored ? stored.isWebhook ? "webhook" : "manual_request" : "not_observed",
      owner: !stored?.leaseToken ? "not_observed"
        : stored.leaseExpiresAt && Date.parse(stored.leaseExpiresAt) > Date.now() ? "lease_observed" : "lease_expired",
      checkpoint: stored ? { phase: stored.phase, pages: stored.pageCount, planned: stored.planCursor, applied: stored.applyCursor } : null,
      lastUpdatedAt: stored?.updatedAt ?? null, backlog: "unavailable", heartbeat: "not_observed",
      connectionProbe: "not_observed", freshness: !stored ? "not_observed"
        : Date.now() - Date.parse(stored.updatedAt) > 15 * 60_000 ? "stale" : "current",
      freshnessThresholdMs: 15 * 60_000,
    },
  };
}

export async function setGhlInboundWebhookEnabled(enabled: boolean, actor: { userId: string; actorId: string }): Promise<GhlInboundSyncStatus> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (enabled) {
      const pause = await client.query("SELECT state FROM outbound_pause_control ORDER BY id LIMIT 1 FOR SHARE");
      if (pause.rows[0]?.state !== "paused") throw new Error("GHL_INBOUND_GLOBAL_OUTBOUND_NOT_PAUSED");
      if (!(process.env.GHL_PRIVATE_INTEGRATION_TOKEN || process.env.GHL_API_KEY) || !process.env.GHL_LOCATION_ID) {
        throw new Error("GHL_INBOUND_NOT_CONFIGURED");
      }
    }
    await client.query(
      "INSERT INTO system_settings(key,value,updated_at) VALUES($1,'false'::jsonb,NOW()) ON CONFLICT DO NOTHING",
      [`${PREFIX}_enabled`],
    );
    const current = await client.query("SELECT value FROM system_settings WHERE key=$1 FOR UPDATE", [`${PREFIX}_enabled`]);
    const before = current.rows[0]?.value === true;
    await client.query(
      `INSERT INTO system_settings(key,value,updated_at) VALUES($1,$2::jsonb,NOW())
       ON CONFLICT(key) DO UPDATE SET value=$2::jsonb,updated_at=NOW()`,
      [`${PREFIX}_enabled`, safeJson(enabled)],
    );
    await client.query(
      `INSERT INTO audit_logs(user_id,action,entity_type,entity_key,before_state,after_state,actor_type,actor_id)
       VALUES($1,'ghl_inbound_webhook_control_changed','integration','ghl_inbound_contact_sync',$2::jsonb,$3::jsonb,'user',$4)`,
      [actor.userId, safeJson({ inboundEnabled: before }), safeJson({ inboundEnabled: enabled }), actor.actorId],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally { client.release(); }
  return getGhlInboundSyncStatus();
}

export async function createGhlInboundPreview(idempotencyKey: string, actorId: string, makeActive = true): Promise<GhlInboundSyncRun> {
  const idemKey = `${PREFIX}_idem_${crypto.createHash("sha256").update(`${actorId}:${idempotencyKey}`).digest("hex")}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO system_settings(key,value,updated_at) VALUES($1,'null',NOW()) ON CONFLICT DO NOTHING", [idemKey]);
    const idem = await client.query("SELECT value FROM system_settings WHERE key=$1 FOR UPDATE", [idemKey]);
    const existingId = idem.rows[0]?.value;
    if (typeof existingId === "string") {
      const old = await client.query("SELECT value FROM system_settings WHERE key=$1", [runKey(existingId)]);
      if (old.rows[0]?.value) {
        if ((old.rows[0].value as StoredRun).actorId !== actorId) throw new Error("GHL_INBOUND_ACTOR_MISMATCH");
        await client.query("COMMIT");
        return publicRun(old.rows[0].value as StoredRun);
      }
    }
    const activeKey = `${PREFIX}_active`;
    await client.query("INSERT INTO system_settings(key,value,updated_at) VALUES($1,'null',NOW()) ON CONFLICT DO NOTHING", [activeKey]);
    const activeRow = await client.query("SELECT value FROM system_settings WHERE key=$1 FOR UPDATE", [activeKey]);
    const activeId = activeRow.rows[0]?.value;
    if (makeActive && typeof activeId === "string") {
      const activeResult = await client.query("SELECT value FROM system_settings WHERE key=$1 FOR UPDATE", [runKey(activeId)]);
      const active = activeResult.rows[0]?.value as StoredRun | undefined;
      if (active) {
        if ((active.leaseExpiresAt && Date.parse(active.leaseExpiresAt) > Date.now()) ||
            ["previewing", "running"].includes(active.state)) {
          throw new Error("GHL_INBOUND_COMMAND_ACTIVE");
        }
        if (active.state === "ready") {
          active.state = "blocked";
          active.nextAction = null;
          active.lastError = "GHL_INBOUND_PREVIEW_SUPERSEDED";
          active.updatedAt = new Date().toISOString();
          await client.query(
            "UPDATE system_settings SET value=$2::jsonb,updated_at=NOW() WHERE key=$1",
            [runKey(activeId), safeJson(active)],
          );
        }
      }
    }
    const run = makeRun(idempotencyKey, actorId);
    await client.query(
      `INSERT INTO system_settings(key,value,updated_at) VALUES($1,$2::jsonb,NOW())
       ON CONFLICT(key) DO UPDATE SET value=$2::jsonb,updated_at=NOW()`,
      [runKey(run.runId), safeJson(run)],
    );
    await client.query("UPDATE system_settings SET value=$2::jsonb,updated_at=NOW() WHERE key=$1", [idemKey, safeJson(run.runId)]);
    if (makeActive) {
      await client.query("UPDATE system_settings SET value=$2::jsonb,updated_at=NOW() WHERE key=$1", [activeKey, safeJson(run.runId)]);
    }
    await client.query("COMMIT");
    return publicRun(run);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally { client.release(); }
}

async function claimRun(id: string): Promise<
  { run: StoredRun; token: string } | { run: StoredRun; busy: true } | { run: StoredRun; terminal: true }
> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const key = runKey(id);
    const row = await client.query("SELECT value FROM system_settings WHERE key=$1 FOR UPDATE", [key]);
    const run = row.rows[0]?.value as StoredRun | undefined;
    if (!run) throw new Error("GHL_INBOUND_RUN_NOT_FOUND");
    if (run.nextAction === null && ["ready", "complete", "blocked"].includes(run.state)) {
      await client.query("COMMIT");
      return { run, terminal: true };
    }
    if (run.leaseExpiresAt && Date.parse(run.leaseExpiresAt) > Date.now()) {
      await client.query("COMMIT");
      return { run, busy: true };
    }
    const token = crypto.randomUUID();
    run.leaseToken = token;
    run.leaseOwner = ownerTag();
    run.leaseExpiresAt = new Date(Date.now() + LEASE_MS).toISOString();
    run.updatedAt = new Date().toISOString();
    await client.query("UPDATE system_settings SET value=$2::jsonb,updated_at=NOW() WHERE key=$1", [key, safeJson(run)]);
    await client.query("COMMIT");
    return { run, token };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally { client.release(); }
}

async function assertInboundApplyAuthority(tx: any, id: string, token: string, pauseEpoch: string | null): Promise<void> {
  const pauseResult = await tx.execute(sql`SELECT state, epoch::text AS epoch FROM outbound_pause_control ORDER BY id LIMIT 1 FOR SHARE`);
  const pause = (pauseResult as any).rows?.[0];
  if (pause?.state !== "paused" || String(pause.epoch) !== pauseEpoch) {
    throw new Error("GHL_INBOUND_PAUSE_EPOCH_CHANGED");
  }
  const result = await tx.execute(sql`SELECT value FROM system_settings WHERE key=${runKey(id)}`);
  const run = (result as any).rows?.[0]?.value as StoredRun | undefined;
  if (!run || run.state !== "running" || run.mode !== "apply" || run.leaseToken !== token ||
      !run.leaseExpiresAt || Date.parse(run.leaseExpiresAt) <= Date.now()) {
    throw new Error("GHL_INBOUND_LEASE_LOST");
  }
  if (run.isWebhook) {
    const enabled = await tx.execute(sql`SELECT value FROM system_settings WHERE key=${`${PREFIX}_enabled`} FOR SHARE`);
    if ((enabled as any).rows?.[0]?.value !== true) throw new Error("GHL_INBOUND_WEBHOOK_LANE_DISABLED");
  }
}

async function fetchPage(
  cursor: StoredRun["scanCursor"],
): Promise<{ contacts: any[]; next: StoredRun["scanCursor"]; total: number | null; locationId: string }> {
  const token = process.env.GHL_PRIVATE_INTEGRATION_TOKEN || process.env.GHL_API_KEY;
  const location = process.env.GHL_LOCATION_ID;
  if (!token || !location) throw new Error("GHL_INBOUND_NOT_CONFIGURED");
  const query = new URLSearchParams({ locationId: location, limit: String(PAGE_SIZE) });
  if (cursor) {
    query.set("startAfter", cursor.startAfter);
    query.set("startAfterId", cursor.startAfterId);
  }
  const response = await fetch(`https://services.leadconnectorhq.com/contacts/?${query}`, {
    redirect: "error",
    method: "GET", headers: { Authorization: `Bearer ${token}`, Version: "2021-07-28", "Content-Type": "application/json" },
    signal: AbortSignal.timeout(Number(process.env.GHL_REQUEST_TIMEOUT_MS || 20000)),
  });
  if (!response.ok) throw new Error(`GHL_INBOUND_HTTP_${response.status}`);
  const body: any = await response.json();
  const items = Array.isArray(body?.contacts) ? body.contacts : Array.isArray(body?.data?.contacts) ? body.data.contacts : null;
  if (!items) throw new Error("GHL_INBOUND_PAGINATION_UNSUPPORTED");
  if (items.length > PAGE_SIZE) throw new Error("GHL_INBOUND_PAGE_SIZE_EXCEEDED");
  const meta = body.meta ?? body.data?.meta ?? {};
  const next = parseGhlInboundCursor(meta, location, PAGE_SIZE);
  const total = meta.total !== undefined && meta.total !== null && Number.isFinite(Number(meta.total)) && Number(meta.total) >= 0
    ? Number(meta.total) : null;
  return { contacts: items, next, total, locationId: location };
}

async function buildPlans(sources: SafeSource[], start: number, end: number): Promise<Plan[]> {
  const duplicates = findDuplicateGhlInboundIdentities(sources);
  const plans: Plan[] = [];
  for (const source of sources.slice(start, end)) {
    if ((source.id && duplicates.ids.has(source.id)) || (source.email && duplicates.emails.has(source.email))) {
      plans.push({ source, kind: "conflict", targetId: null, fill: {}, reason: "duplicate_remote_identity" });
      continue;
    }
    if (!source.id) {
      plans.push(evaluateGhlInboundIdentity(source, []));
      continue;
    }
    const conditions = [eq(contacts.ghlContactId, source.id)];
    if (source.email) conditions.push(sql`lower(trim(${contacts.email})) = ${source.email}`);
    const found = await db.select().from(contacts).where(or(...conditions)).limit(30);
    plans.push(evaluateGhlInboundIdentity(source, found));
  }
  return plans;
}

export function findDuplicateGhlInboundIdentities(sources: SafeSource[]): { ids: Set<string>; emails: Set<string> } {
  const ids = new Map<string, number>();
  const emails = new Map<string, number>();
  for (const s of sources) {
    if (s.id) ids.set(s.id, (ids.get(s.id) ?? 0) + 1);
    if (s.email) emails.set(s.email, (emails.get(s.email) ?? 0) + 1);
  }
  return {
    ids: new Set([...ids].filter(([, n]) => n > 1).map(([id]) => id)),
    emails: new Set([...emails].filter(([, n]) => n > 1).map(([email]) => email)),
  };
}

/** Pure identity/fill planner shared by the durable preview and focused tests. */
export function evaluateGhlInboundIdentity(source: SafeSource, candidates: any[], duplicateRemote = false): Plan {
  if (duplicateRemote) return { source, kind: "conflict", targetId: null, fill: {}, reason: "duplicate_remote_identity" };
  if (!source.id) return { source, kind: "skip", targetId: null, fill: {}, reason: "missing_usable_identity" };
  const active = candidates.filter(c => !(c.archivedAt ?? c.archived_at));
  const archived = candidates.filter(c => !!(c.archivedAt ?? c.archived_at));
  if (archived.length && !active.length) return { source, kind: "conflict", targetId: null, fill: {}, reason: "archived_local_identity" };
  if (active.length > 1 || archived.length) return { source, kind: "conflict", targetId: null, fill: {}, reason: "ambiguous_local_identity" };
  if (!active.length) {
    if (!usableEmail(source.email) && !usablePhone(source.phone)) {
      return { source, kind: "skip", targetId: null, fill: {}, reason: "missing_usable_identity" };
    }
    return { source, kind: "create", targetId: null, fill: {} };
  }
  const contact = active[0];
  const localId = contact.ghlContactId ?? contact.ghl_contact_id;
  const localEmail = contact.email;
  const byId = localId === source.id;
  const byEmail = !!source.email && normalizedEmail(localEmail) === source.email;
  if (byId && source.email && localEmail && normalizedEmail(localEmail) !== source.email) {
    return { source, kind: "conflict", targetId: null, fill: {}, reason: "linked_email_disagrees" };
  }
  if (byEmail && localId && localId !== source.id) {
    return { source, kind: "conflict", targetId: null, fill: {}, reason: "ghl_id_owned_by_different_contact" };
  }
  const fill: Record<string, string> = {};
  for (const field of FIELDS) {
    const incoming = source[field];
    const current = field === "email" ? normalizedEmail(contact[field]) : trimmed(contact[field]);
    if (!current && incoming) fill[field] = incoming;
  }
  if (!localId) fill.ghlContactId = source.id;
  const preservedDifference = FIELDS.some(f => source[f] && nonblank(contact[f]) &&
    (f === "email" ? normalizedEmail(contact[f]) !== source[f] : trimmed(contact[f]) !== source[f]));
  return {
    source, kind: Object.keys(fill).length ? "update" : "unchanged",
    targetId: Number(contact.id), fill,
    ...(preservedDifference ? { reason: "existing_nonblank_value_preserved" } : {}),
  };
}

export function normalizeGhlInboundLocalContactRow(row: any) {
  return {
    ...row,
    id: Number(row.id),
    archivedAt: row.archivedAt ?? row.archived_at ?? null,
    ghlContactId: row.ghlContactId ?? row.ghl_contact_id ?? null,
    firstName: row.firstName ?? row.first_name ?? "",
    lastName: row.lastName ?? row.last_name ?? "",
    companyName: row.companyName ?? row.company_name ?? "",
  };
}

function summarizePreview(run: StoredRun) {
  run.counts = EMPTY_COUNTS();
  for (const plan of run.plans) {
    run.counts.scanned++;
    if (plan.kind === "create") run.counts.wouldCreate++;
    else if (plan.kind === "update") { run.counts.matched++; run.counts.wouldUpdate++; }
    else if (plan.kind === "unchanged") { run.counts.matched++; run.counts.unchanged++; }
    else if (plan.kind === "conflict") {
      run.counts.conflicts++;
      issue(run, plan.source.id || null, plan.reason || "identity_conflict");
    } else {
      run.counts.skipped++;
      issue(run, plan.source.id || null, plan.reason || "unidentifiable");
    }
    if (plan.reason === "existing_nonblank_value_preserved") {
      if (plan.kind !== "conflict") run.counts.conflicts++;
      issue(run, plan.source.id || null, plan.reason);
    }
  }
  run.previewHash = crypto.createHash("sha256").update(safeJson(run.plans)).digest("hex");
}

export async function advanceGhlInboundSyncStep(id: string): Promise<{ run: GhlInboundSyncRun; busy: boolean }> {
  const claim = await claimRun(id);
  if ("busy" in claim) return { run: publicRun(claim.run), busy: true };
  if ("terminal" in claim) return { run: publicRun(claim.run), busy: false };
  const run = claim.run;
  const token = claim.token;
  try {
    if (run.state === "previewing") {
      if (run.phase === "read" && (run.pageCount >= MAX_PAGES || run.sources.length >= MAX_REMOTE_CONTACTS)) {
        run.state = "blocked"; run.nextAction = null; run.lastError = "GHL_INBOUND_PREVIEW_CAP_REACHED";
      } else if (run.phase === "read") {
        const page = await fetchPage(run.scanCursor);
        if (page.contacts.some(contact => contact?.locationId !== page.locationId)) {
          throw new Error("GHL_INBOUND_CONTACT_LOCATION_MISMATCH");
        }
        const sanitized = page.contacts.map(sanitizeGhlInboundContact);
        run.sources.push(...sanitized.map(x => x ?? ({
          id: "", firstName: "", lastName: "", email: "", phone: "", companyName: "",
        } as SafeSource)));
        run.counts.scanned += sanitized.length;
        run.pageCount++;
        const scanned = run.sources.length;
        if (page.total !== null) {
          if (run.remoteTotal !== null && run.remoteTotal !== page.total) throw new Error("GHL_INBOUND_PAGINATION_TOTAL_CHANGED");
          if (scanned > page.total) throw new Error("GHL_INBOUND_PAGINATION_TOTAL_INVALID");
          run.remoteTotal = page.total;
        }
        const hasMore = !!page.next || (page.total !== null
          ? scanned < page.total
          : page.contacts.length === PAGE_SIZE);
        if (hasMore && !page.next) throw new Error("GHL_INBOUND_PAGINATION_INCOMPLETE");
        if (page.next) {
          const cursorKey = `${page.next.startAfterId}:${page.next.startAfter}`;
          if (run.seenCursors.includes(cursorKey)) throw new Error("GHL_INBOUND_PAGINATION_LOOP");
          run.seenCursors.push(cursorKey);
          run.scanCursor = page.next;
        } else {
          run.phase = "plan";
          run.nextAction = "scan";
        }
      } else {
        const end = Math.min(run.planCursor + PLAN_PAGE_SIZE, run.sources.length);
        run.plans.push(...await buildPlans(run.sources, run.planCursor, end));
        run.planCursor = end;
        if (run.planCursor >= run.sources.length) {
          summarizePreview(run);
          run.state = "ready";
          run.nextAction = null;
        }
      }
    } else if (run.mode === "apply" && run.state === "running") {
      const start = run.applyCursor;
      const end = Math.min(start + APPLY_PAGE_SIZE, run.plans.length);
      await db.transaction(async (tx) => {
        const pauseResult = await tx.execute(sql`SELECT state, epoch::text AS epoch FROM outbound_pause_control ORDER BY id LIMIT 1 FOR SHARE`);
        const pause = (pauseResult as any).rows?.[0];
        if (pause?.state !== "paused" || String(pause.epoch) !== run.pauseEpoch) throw new Error("GHL_INBOUND_PAUSE_EPOCH_CHANGED");
        const lock = await tx.execute(sql`SELECT value FROM system_settings WHERE key=${runKey(id)} FOR UPDATE`);
        const persisted = lock.rows?.[0]?.value as StoredRun | undefined;
        if (!persisted || persisted.state !== "running" || persisted.mode !== "apply" ||
            persisted.leaseToken !== token || !persisted.leaseExpiresAt || Date.parse(persisted.leaseExpiresAt) < Date.now()) {
          throw new Error("GHL_INBOUND_LEASE_LOST");
        }
        if (persisted.isWebhook) {
          const enabled = await tx.execute(sql`SELECT value FROM system_settings WHERE key=${`${PREFIX}_enabled`} FOR SHARE`);
          if ((enabled as any).rows?.[0]?.value !== true) throw new Error("GHL_INBOUND_WEBHOOK_LANE_DISABLED");
        }
        run.leaseExpiresAt = new Date(Date.now() + LEASE_MS).toISOString();
        persisted.leaseExpiresAt = run.leaseExpiresAt;
        await tx.execute(sql`UPDATE system_settings SET value=${safeJson(persisted)}::jsonb,updated_at=NOW() WHERE key=${runKey(id)}`);
        for (let i = start; i < end; i++) {
          const plan = run.plans[i];
          if (plan.kind !== "create" && plan.kind !== "update") continue;
          const keys = [`ghl:${plan.source.id}`, ...(plan.source.email ? [`email:${plan.source.email}`] : [])].sort();
          for (const key of keys) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`);
          // Shared mailbox protocol: take the destination mailbox lock BEFORE the identity row locks below, so a
          // concurrent Data Health reconcile or other mailbox writer serializes with this apply.
          await lockContactMailboxes(tx, [plan.source.email]);
          const pauseCheckResult = await tx.execute(sql`SELECT state, epoch::text AS epoch FROM outbound_pause_control ORDER BY id LIMIT 1 FOR SHARE`);
          const pauseCheck = (pauseCheckResult as any).rows?.[0];
          if (pauseCheck?.state !== "paused" || String(pauseCheck.epoch) !== run.pauseEpoch) throw new Error("GHL_INBOUND_PAUSE_EPOCH_CHANGED");
          run.leaseExpiresAt = new Date(Date.now() + LEASE_MS).toISOString();
          await tx.execute(sql`UPDATE system_settings SET value=${safeJson(run)}::jsonb,updated_at=NOW() WHERE key=${runKey(id)}`);
          const currentRunResult = await tx.execute(sql`SELECT value FROM system_settings WHERE key=${runKey(id)}`);
          const currentRun = (currentRunResult as any).rows?.[0];
          const authority = currentRun?.value as StoredRun | undefined;
          if (!authority || authority.state !== "running" || authority.mode !== "apply" ||
              authority.leaseToken !== token || Date.parse(authority.leaseExpiresAt || "") < Date.now()) {
            throw new Error("GHL_INBOUND_LEASE_LOST");
          }
          const identityRows = await tx.execute(sql`
            SELECT * FROM contacts
            WHERE (ghl_contact_id=${plan.source.id} OR (${plan.source.email} <> '' AND lower(trim(email))=${plan.source.email}))
            ORDER BY id FOR UPDATE
          `) as any;
          const rows = (identityRows.rows ?? []).map(normalizeGhlInboundLocalContactRow);
          const active = rows.filter((r: any) => !r.archivedAt);
          if (rows.some((r: any) => r.archivedAt) || active.length > 1 ||
              (active.length === 1 && plan.targetId !== null && Number(active[0].id) !== plan.targetId) ||
              (active.length === 1 && plan.targetId === null) ||
              (active.length === 0 && plan.targetId !== null)) {
            run.counts.skipped++;
            issue(run, plan.source.id, "identity_changed_since_preview");
            continue;
          }
          if (active.length === 1 && active[0].ghlContactId && active[0].ghlContactId !== plan.source.id) {
            run.counts.skipped++;
            issue(run, plan.source.id, "ghl_id_ownership_changed");
            continue;
          }
          if (active.length === 1 && active[0].ghlContactId === plan.source.id && plan.source.email &&
              nonblank(active[0].email) && normalizedEmail(active[0].email) !== plan.source.email) {
            run.counts.skipped++;
            issue(run, plan.source.id, "linked_email_disagrees");
            continue;
          }
          if (plan.kind === "create" && active.length === 0) {
            await assertInboundApplyAuthority(tx, id, token, run.pauseEpoch);
            const written = await writeContact({
              mode: "ghl_inbound_no_echo",
              mutation: {
                firstName: plan.source.firstName, lastName: plan.source.lastName,
                email: plan.source.email, phone: plan.source.phone, companyName: plan.source.companyName,
                ghlContactId: plan.source.id,
              },
              provenance: {
                sourceCategory: "ghl_sync", sourceType: "inbound",
                eventKey: `ghl-inbound:${plan.source.id}`, sourceExternalId: plan.source.id,
                actorType: "system", metadata: { reconciliation: "approved_one_way" },
              },
              actor: { actorType: "system" }, hookPolicy: hooks, transaction: tx,
            });
            if (written._intakeOutcome === "created") run.counts.created++;
            else {
              run.counts.skipped++;
              issue(run, plan.source.id, "identity_created_concurrently_not_overwritten");
            }
          } else if (active.length === 1) {
            const local = active[0];
            const updates: Record<string, unknown> = {};
            for (const field of FIELDS) {
              const remote = plan.source[field];
              const localValue = field === "email" ? normalizedEmail(local.email) : trimmed(local[field]);
              if (!localValue && remote) updates[field] = remote;
            }
            if (!local.ghlContactId) updates.ghlContactId = plan.source.id;
            for (const field of FIELDS) {
              if (plan.source[field] && nonblank(local[field]) &&
                  (field === "email" ? normalizedEmail(local.email) !== plan.source[field] : trimmed(local[field]) !== plan.source[field])) {
                if (plan.reason !== "existing_nonblank_value_preserved") run.counts.conflicts++;
                issue(run, plan.source.id, "existing_nonblank_value_preserved");
                break;
              }
            }
            if (Object.keys(updates).length) {
              await assertInboundApplyAuthority(tx, id, token, run.pauseEpoch);
              await updateContactLocalFirst(Number(local.id), updates as any, { actorType: "system" }, undefined, hooks, tx);
              run.counts.updated++;
            } else {
              run.counts.skipped++;
              issue(run, plan.source.id, "no_gaps_remain_since_preview");
            }
          }
        }
        run.applyCursor = end;
        run.updatedAt = new Date().toISOString();
        if (run.applyCursor >= run.plans.length) { run.state = "complete"; run.nextAction = null; }
        run.lastError = null;
        const leaseStamp = new Date(Date.now() + LEASE_MS).toISOString();
        run.leaseExpiresAt = leaseStamp;
        await tx.execute(sql`UPDATE system_settings SET value=${safeJson(run)}::jsonb,updated_at=NOW() WHERE key=${runKey(id)}`);
      });
      return { run: publicRun(run), busy: false };
    }
    run.updatedAt = new Date().toISOString();
    run.lastError = null;
    await writeRunFenced(run, token);
    return { run: publicRun(run), busy: false };
  } catch (error) {
    const persisted = await readRun(id).catch(() => null);
    if (persisted?.leaseToken === token) Object.assign(run, persisted);
    const code = safeOperationalError(error);
    if (code === "GHL_INBOUND_GLOBAL_OUTBOUND_NOT_PAUSED" || code === "GHL_INBOUND_PAUSE_EPOCH_CHANGED") {
      run.state = "running";
      run.nextAction = "apply";
    } else {
      run.state = "failed";
      run.nextAction = null;
    }
    run.lastError = code;
    run.updatedAt = new Date().toISOString();
    await writeRunFenced(run, token).catch(() => undefined);
    throw error;
  } finally {
    await pool.query(
      `UPDATE system_settings SET value=(value - 'leaseToken' - 'leaseOwner' - 'leaseExpiresAt') || '{"leaseToken":null,"leaseOwner":null,"leaseExpiresAt":null}'::jsonb,updated_at=NOW()
       WHERE key=$1 AND value->>'leaseToken'=$2 AND (value->>'leaseExpiresAt')::timestamptz > NOW()`,
      [runKey(id), token],
    ).catch(() => undefined);
  }
}

export async function getGhlInboundSyncRun(id: string): Promise<GhlInboundSyncRun | null> {
  const run = await readRun(id);
  return run ? publicRun(run) : null;
}

export async function executeGhlInboundSync(
  id: string, previewHash: string, idempotencyKey: string, actorId: string,
): Promise<GhlInboundSyncRun> {
  const idemKey = `${PREFIX}_execute_${crypto.createHash("sha256").update(`${actorId}:${idempotencyKey}`).digest("hex")}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO system_settings(key,value,updated_at) VALUES($1,'null',NOW()) ON CONFLICT DO NOTHING", [idemKey]);
    const idem = await client.query("SELECT value FROM system_settings WHERE key=$1 FOR UPDATE", [idemKey]);
    if (idem.rows[0]?.value) {
      if (idem.rows[0].value !== id) throw new Error("GHL_INBOUND_IDEMPOTENCY_KEY_REUSED");
      const known = await client.query("SELECT value FROM system_settings WHERE key=$1", [runKey(id)]);
      if (known.rows[0]?.value) {
        const replay = known.rows[0].value as StoredRun;
        if (replay.actorId !== actorId) throw new Error("GHL_INBOUND_ACTOR_MISMATCH");
        if (replay.previewHash !== previewHash) throw new Error("GHL_INBOUND_PREVIEW_HASH_MISMATCH");
        await client.query("COMMIT");
        return publicRun(replay);
      }
    }
    const active = await client.query("SELECT value FROM system_settings WHERE key=$1 FOR UPDATE", [`${PREFIX}_active`]);
    if (active.rows[0]?.value !== id) throw new Error("GHL_INBOUND_COMMAND_NOT_ACTIVE");
    const selected = await client.query("SELECT value FROM system_settings WHERE key=$1 FOR UPDATE", [runKey(id)]);
    const run = selected.rows[0]?.value as StoredRun | undefined;
    if (!run) throw new Error("GHL_INBOUND_RUN_NOT_FOUND");
    if (run.actorId !== actorId) throw new Error("GHL_INBOUND_ACTOR_MISMATCH");
    if (run.previewHash !== previewHash || !previewHash) throw new Error("GHL_INBOUND_PREVIEW_HASH_MISMATCH");
    if (run.state !== "ready") throw new Error("GHL_INBOUND_RUN_NOT_READY");
    const pause = await client.query("SELECT state,epoch::text AS epoch FROM outbound_pause_control ORDER BY id LIMIT 1 FOR SHARE");
    if (pause.rows[0]?.state !== "paused") throw new Error("GHL_INBOUND_GLOBAL_OUTBOUND_NOT_PAUSED");
    run.mode = "apply"; run.state = "running"; run.nextAction = "apply"; run.applyCursor = 0;
    run.pauseEpoch = String(pause.rows[0].epoch);
    run.updatedAt = new Date().toISOString();
    await client.query("UPDATE system_settings SET value=$2::jsonb,updated_at=NOW() WHERE key=$1", [runKey(id), safeJson(run)]);
    await client.query("UPDATE system_settings SET value=$2::jsonb,updated_at=NOW() WHERE key=$1", [idemKey, safeJson(id)]);
    await client.query("COMMIT");
    return publicRun(run);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally { client.release(); }
}

/** Contact event entrypoint. It uses the same sanitization, narrow field policy, and identity checks as bulk reconciliation. */
export async function reconcileGhlInboundWebhookContact(payload: any): Promise<void> {
  if (await readSetting<boolean>(`${PREFIX}_enabled`) !== true) return;
  const locationId = process.env.GHL_LOCATION_ID;
  const contactPayload = payload?.contact && typeof payload.contact === "object"
    ? payload.contact
    : { ...payload, id: typeof payload?.contactId === "string" ? payload.contactId : payload?.id };
  if (!locationId || (contactPayload?.locationId ?? payload?.locationId) !== locationId) {
    throw new Error("GHL_INBOUND_WEBHOOK_LOCATION_MISMATCH");
  }
  const source = sanitizeGhlInboundContact(contactPayload);
  if (!source) return;
  const plans = await buildPlans([source], 0, 1);
  const plan = plans[0];
  if (plan.kind === "conflict" || plan.kind === "skip") return;
  const eventHash = crypto.createHash("sha256").update(safeJson({
    eventId: payload?.eventId ?? payload?.id ?? null, source,
  })).digest("hex");
  const created = await createGhlInboundPreview(`webhook:${source.id}:${eventHash}`, `ghl-webhook:${locationId}`, false);
  let run = await readRun(created.runId);
  if (!run) throw new Error("GHL_INBOUND_RUN_NOT_FOUND");
  if (run.state === "complete") return;
  const claim = await claimRun(run.runId);
  if ("busy" in claim || "terminal" in claim) return;
  run = claim.run;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const enabled = await client.query(
      "SELECT value FROM system_settings WHERE key=$1 FOR SHARE",
      [`${PREFIX}_enabled`],
    );
    if (enabled.rows[0]?.value !== true) throw new Error("GHL_INBOUND_WEBHOOK_LANE_DISABLED");
    const pause = await client.query(
      "SELECT state,epoch::text AS epoch FROM outbound_pause_control ORDER BY id LIMIT 1 FOR SHARE",
    );
    if (pause.rows[0]?.state !== "paused") throw new Error("GHL_INBOUND_GLOBAL_OUTBOUND_NOT_PAUSED");
    const persistedResult = await client.query(
      "SELECT value FROM system_settings WHERE key=$1 FOR UPDATE",
      [runKey(run.runId)],
    );
    const persisted = persistedResult.rows[0]?.value as StoredRun | undefined;
    if (!persisted || persisted.leaseToken !== claim.token || !persisted.leaseExpiresAt ||
        Date.parse(persisted.leaseExpiresAt) <= Date.now()) throw new Error("GHL_INBOUND_LEASE_LOST");
    run = persisted;
    if (run.mode !== "apply") {
      run.sources = [source];
      run.plans = plans;
      run.mode = "apply";
      run.state = "running";
      run.phase = "plan";
      run.previewHash = crypto.createHash("sha256").update(safeJson(plans)).digest("hex");
      run.nextAction = "apply";
      run.counts.scanned = 1;
      run.counts.matched = plan.targetId === null ? 0 : 1;
      run.counts.wouldCreate = plan.kind === "create" ? 1 : 0;
      run.counts.wouldUpdate = plan.kind === "update" ? 1 : 0;
      run.counts.unchanged = plan.kind === "unchanged" ? 1 : 0;
    }
    if (run.state === "failed") {
      run.state = "running";
      run.nextAction = "apply";
      run.lastError = null;
    }
    run.isWebhook = true;
    if (run.applyCursor === 0) run.pauseEpoch = String(pause.rows[0].epoch);
    run.updatedAt = new Date().toISOString();
    const saved = await client.query(
      `UPDATE system_settings SET value=$2::jsonb,updated_at=NOW()
       WHERE key=$1 AND value->>'leaseToken'=$3
         AND (value->>'leaseExpiresAt')::timestamptz > NOW()`,
      [runKey(run.runId), safeJson(run), claim.token],
    );
    if (saved.rowCount !== 1) throw new Error("GHL_INBOUND_LEASE_LOST");
    await client.query("COMMIT");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await pool.query(
      `UPDATE system_settings SET value=(value - 'leaseToken' - 'leaseOwner' - 'leaseExpiresAt') || '{"leaseToken":null,"leaseOwner":null,"leaseExpiresAt":null}'::jsonb,updated_at=NOW()
       WHERE key=$1 AND value->>'leaseToken'=$2 AND (value->>'leaseExpiresAt')::timestamptz > NOW()`,
      [runKey(run.runId), claim.token],
    ).catch(() => undefined);
  }
  await advanceGhlInboundSyncStep(run.runId);
}