/**
 * Bounded discovery of businesses whose classification should be reconsidered.
 *
 * Work per tick is bounded by a persisted keyset cursor over business ids, not by the size of the
 * classification table: each tick examines at most RECONSIDERATION_WINDOW consecutive canonical
 * businesses, looks up each one's latest rows through the (business_id, policy_version, created_at)
 * index, and returns at most `limit` of them. The cursor then advances:
 *   - past the last business returned, when more than `limit` were found (the rest are found on the
 *     next tick, so no due business is skipped);
 *   - to the end of the window otherwise;
 *   - back to the start once the end of the business table is reached, which begins the next pass.
 * One full pass over the canonical businesses therefore takes ceil(businesses / window) ticks plus the
 * ticks needed to work through what it finds; nothing is recomputed over the whole table per tick.
 *
 * What is returned, in precedence order, per business:
 *  due     the latest completed result no longer stands (shared definition in sfp-reconsideration.ts),
 *          unless an up-to-date non-attempt was already recorded for it recently (a day when the site
 *          could not be read, otherwise a week); changed inputs make that record stale at once;
 *  unread  the latest result is a free-window non-attempt that never read the business's website;
 *  recheck the latest result is a website-based acceptance whose site has not been read for
 *          SFP_WEBSITE_RECHECK_DAYS. This interval is a schedule, not a deadline: when the backlog of
 *          due and unread businesses is large they are served first and the pass takes longer.
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { SFP_VERTICAL_ACCEPTANCE_POLICY_VERSION } from "./sfp-vertical-acceptance";
import { SFP_WEBSITE_RECHECK_DAYS, sfpReconsiderationDueSql, type SfpReconsiderationVersions } from "./sfp-reconsideration";
import { sfpInputFingerprintSql } from "../../../shared/sfp-input-fingerprint";

export const RECONSIDERATION_WINDOW = 1000;
/** A tick scans at most this many windows (10,000 businesses) while looking for work. */
export const RECONSIDERATION_MAX_WINDOWS_PER_TICK = 10;
/** Upper bound on one discovery query; a tick that exceeds it fails loudly instead of holding a connection. */
const DISCOVERY_STATEMENT_TIMEOUT = "20s";

export type ReconsiderationKind = "due" | "unread" | "recheck";
export interface ReconsiderationWork { businessId: number; kind: ReconsiderationKind }

const rows = (r: any): any[] => r?.rows ?? r ?? [];
const int = (n: number): number => {
  if (!Number.isInteger(n)) throw new Error("SFP_RECONSIDERATION_DISCOVERY_PARAMETER_INVALID");
  return n;
};

export function reconsiderationCursorKey(programId: string, v: SfpReconsiderationVersions): string {
  if (!/^[0-9a-f-]{36}$/i.test(programId)) throw new Error("SFP_RECONSIDERATION_PROGRAM_INVALID");
  return `sfp_reconsideration_cursor:${programId}:p${int(v.policyVersion)}:c${int(v.classifierVersion)}:a${SFP_VERTICAL_ACCEPTANCE_POLICY_VERSION}`;
}

function latestRowLateral(alias: string, v: SfpReconsiderationVersions, completedOnly: boolean): string {
  return `LEFT JOIN LATERAL (
      SELECT x.* FROM sfp_classification_evidence x
       WHERE x.business_id=b.id AND x.policy_version=${int(v.policyVersion)}
         AND x.classifier_version=${int(v.classifierVersion)} AND x.taxonomy_version=${int(v.taxonomyVersion)}
         ${completedOnly ? "AND x.terminal_state='completed'" : ""}
       ORDER BY x.created_at DESC,x.id DESC LIMIT 1
    ) ${alias} ON TRUE`;
}

/** The exact discovery statement for the business-id range (cursor, maxId]. */
export function reconsiderationDiscoverySql(
  v: SfpReconsiderationVersions, limit: number, cursor: number, maxId: number,
): string {
  const due = sfpReconsiderationDueSql("e", "b", v);
  return `SELECT business_id, kind FROM (
    SELECT b.id AS business_id,
      CASE
        WHEN e.id IS NOT NULL AND ${due}
             AND NOT EXISTS (
               SELECT 1 FROM sfp_classification_evidence r
                WHERE r.business_id=b.id AND r.policy_version=e.policy_version
                  AND r.classifier_version=e.classifier_version AND r.taxonomy_version=${int(v.taxonomyVersion)}
                  AND r.terminal_state='provisional' AND r.created_at>e.created_at
                  AND r.created_at>NOW()-(CASE WHEN r.reason_codes::text LIKE '%WEBSITE_EVIDENCE_UNAVAILABLE%'
                                               THEN INTERVAL '1 day' ELSE INTERVAL '7 days' END)
                  AND r.acceptance_policy_version=${SFP_VERTICAL_ACCEPTANCE_POLICY_VERSION}
                  AND r.input_fingerprint=${sfpInputFingerprintSql("b")})
          THEN 'due'
        WHEN a.terminal_state='provisional'
             AND a.reason_codes @> '["FREE_ONLY_WEBSITE_EVIDENCE_NOT_FETCHED"]'::jsonb
             AND NULLIF(btrim(b.website_domain),'') IS NOT NULL
          THEN 'unread'
        WHEN e.id IS NOT NULL AND e.outcome='target' AND e.acceptance_facts->>'websiteSourceUrl' IS NOT NULL
             AND NOT ${due}
             AND NOT EXISTS (
               SELECT 1 FROM sfp_classification_items i
                 JOIN sfp_classification_runs cr ON cr.id=i.run_id
                WHERE i.business_id=b.id AND cr.policy_version=e.policy_version AND i.state='completed'
                  AND i.completed_at>NOW()-make_interval(days => ${SFP_WEBSITE_RECHECK_DAYS}))
          THEN 'recheck'
      END AS kind
     FROM businesses b
     ${latestRowLateral("e", v, true)}
     ${latestRowLateral("a", v, false)}
    WHERE b.record_class='canonical' AND b.id>${int(cursor)} AND b.id<=${int(maxId)}
  ) found WHERE kind IS NOT NULL
  ORDER BY business_id LIMIT ${int(limit) + 1}`;
}

export function reconsiderationWindowSql(cursor: number, windowSize: number): string {
  return `SELECT count(*)::int AS examined, COALESCE(max(id),${int(cursor)})::int AS max_id FROM (
    SELECT id FROM businesses WHERE record_class='canonical' AND id>${int(cursor)} ORDER BY id LIMIT ${int(windowSize)}) w`;
}

/** Statements the measurement harness explains: the window bound and the discovery query. */
export function reconsiderationExplainQueries(input: {
  versions: SfpReconsiderationVersions; limit: number; windowSize: number; cursor: number; maxId: number;
}): Record<string, string> {
  return {
    window: reconsiderationWindowSql(input.cursor, input.windowSize),
    discovery: reconsiderationDiscoverySql(input.versions, input.limit, input.cursor, input.maxId),
  };
}

export async function readReconsiderationCursor(programId: string, v: SfpReconsiderationVersions): Promise<{
  businessId: number; pass: number; lastError: string | null;
}> {
  const found = rows(await db.execute(sql`SELECT value FROM system_settings WHERE key=${reconsiderationCursorKey(programId, v)}`))[0]?.value;
  const value = typeof found === "string" ? JSON.parse(found) : found ?? {};
  return {
    businessId: Number.isInteger(value.businessId) ? value.businessId : 0,
    pass: Number.isInteger(value.pass) ? value.pass : 1,
    lastError: typeof value.lastError === "string" ? value.lastError : null,
  };
}

export async function writeReconsiderationCursor(
  programId: string, v: SfpReconsiderationVersions,
  state: { businessId: number; pass: number; lastError?: string | null },
): Promise<void> {
  const value = JSON.stringify({ ...state, lastError: state.lastError ?? null, updatedAt: new Date().toISOString() });
  await db.execute(sql`
    INSERT INTO system_settings (key,value,updated_at) VALUES (${reconsiderationCursorKey(programId, v)},${value}::jsonb,NOW())
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`);
}

export interface ReconsiderationDiscovery {
  work: ReconsiderationWork[];
  examined: number;
  /** Cursor to persist once the returned work has been handled. */
  next: { businessId: number; pass: number };
  passCompleted: boolean;
}

export async function discoverReconsiderationWork(input: {
  programId: string; versions: SfpReconsiderationVersions; limit: number; windowSize?: number; maxWindows?: number;
}): Promise<ReconsiderationDiscovery> {
  const windowSize = input.windowSize ?? RECONSIDERATION_WINDOW;
  const maxWindows = input.maxWindows ?? RECONSIDERATION_MAX_WINDOWS_PER_TICK;
  const start = await readReconsiderationCursor(input.programId, input.versions);
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout='${DISCOVERY_STATEMENT_TIMEOUT}'`));
    let cursor = start.businessId;
    let pass = start.pass;
    let examinedTotal = 0;
    let passCompleted = false;
    const work: ReconsiderationWork[] = [];
    // Several cheap windows per tick, stopping as soon as a tick's worth of work is found, so a quiet
    // pass over the whole table takes a handful of ticks while one tick's cost stays bounded.
    for (let i = 0; i < maxWindows; i++) {
      const window = rows(await tx.execute(sql.raw(reconsiderationWindowSql(cursor, windowSize))))[0];
      const examined = Number(window.examined);
      const maxId = Number(window.max_id);
      examinedTotal += examined;
      const found = examined === 0 ? [] : rows(await tx.execute(sql.raw(
        reconsiderationDiscoverySql(input.versions, input.limit - work.length, cursor, maxId),
      ))).map((r: any) => ({ businessId: Number(r.business_id), kind: r.kind as ReconsiderationKind }));
      const room = input.limit - work.length;
      const more = found.length > room;
      const taken = more ? found.slice(0, room) : found;
      work.push(...taken);
      if (more) { cursor = taken.length > 0 ? taken[taken.length - 1].businessId : cursor; break; }
      if (examined < windowSize) { cursor = 0; pass += 1; passCompleted = true; break; }
      cursor = maxId;
      if (work.length >= input.limit) break;
    }
    return { work, examined: examinedTotal, passCompleted, next: { businessId: cursor, pass } };
  });
}
