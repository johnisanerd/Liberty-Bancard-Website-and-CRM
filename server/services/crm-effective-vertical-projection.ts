import { sql } from "drizzle-orm";
import { db } from "../db";
import { effectiveBusinessVerticalSql,effectiveContactVerticalSql,
  effectiveBusinessVerticalStatusSql,effectiveContactVerticalStatusSql } from "@shared/effective-vertical";

const KEY = "crm_effective_vertical_projection_v1";
const rows = (result: any): any[] => result?.rows ?? result ?? [];
const MIN_SLICE = 10;
const BUSINESS_SLICE = { start: 1000, max: 2500 };
const CONTACT_SLICE = { start: 100, max: 500 };
export type EffectiveVerticalProjectionOptions = {
  /** Per-slice statement timeout; a slice that exceeds it is rolled back (savepoint) and retried at half the size. */
  sliceTimeoutMs?: number;
  /** Wall-clock share of one tick each lane may spend starting further slices. */
  businessBudgetMs?: number;
  contactBudgetMs?: number;
  /** Certification only: milliseconds to stall a slice inside its savepoint, to exercise the timeout path. */
  faultInjection?: (lane: "business" | "contact", sliceRows: number) => number;
};
const sqlStateOf = (error: any): string | undefined => error?.code ?? error?.cause?.code;
const num = (value: unknown, fallback: number) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;

/** Bounded/resumable, entirely DB-local. Does not classify from a filename,
 * modify raw labels/history, contact providers, or change outbound state.
 *
 * Page work is sliced. The authoritative contact reader costs about 100 ms for each contact with a verified
 * business relationship (it evaluates the full relationship evidence), so one fixed 2,500-row page exceeded the
 * 30-second statement timeout on every tick since Oct 16 and the checkpoint never advanced. Each lane now reads and
 * writes small slices, each in its own savepoint with its own statement timeout; a slice that times out is rolled
 * back, retried at half the size, and the slice size adapts to the measured time. Only committed slices advance the
 * cursor, and the cursor, counters and frozen high-water marks are checkpointed once per tick exactly as before. */
export async function processEffectiveVerticalProjectionTick(limit = 2500, options: EffectiveVerticalProjectionOptions = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("CRM_PROJECTION_PAGE_LIMIT_INVALID");
  const pageLimit=Math.min(limit,5000);
  const sliceTimeoutMs = Math.floor(num(options.sliceTimeoutMs, 8000));
  const businessBudgetMs = num(options.businessBudgetMs, 6000);
  const contactBudgetMs = num(options.contactBudgetMs, 15000);
  return db.transaction(async tx => {
    const locked = rows(await tx.execute(sql`SELECT pg_try_advisory_xact_lock(
      hashtextextended(${KEY},0)) AS locked`))[0]?.locked;
    if (!locked) return { ran: false };
    await tx.execute(sql`INSERT INTO system_settings(key,value,updated_at)
      VALUES (${KEY},'{"businessCursor":0,"contactCursor":0,"cycles":0}'::jsonb,NOW())
      ON CONFLICT(key) DO NOTHING`);
    let state = rows(await tx.execute(sql`SELECT value FROM system_settings WHERE key=${KEY} FOR UPDATE`))[0].value;
    if (state.coverageVersion!==2 || state.scanStartedAt == null) {
      // Legacy cursors have no frozen population or scanned-row accounting.
      // Start a verifiable pass rather than rebrand an old partial pass as one.
      const population=rows(await tx.execute(sql`SELECT clock_timestamp()::text AS started_at,
        (SELECT COALESCE(max(id),0) FROM businesses)::integer AS business_high_water,
        (SELECT COALESCE(max(id),0) FROM contacts)::integer AS contact_high_water,
        (SELECT count(*) FROM businesses)::integer AS business_total,
        (SELECT count(*) FROM contacts)::integer AS contact_total`))[0];
      state={...state,coverageVersion:2,scope:"all_record_classes",
        businessCursor:0,contactCursor:0,scanStartedAt:population.started_at,
        businessHighWater:population.business_high_water,contactHighWater:population.contact_high_water,
        populationBusinesses:population.business_total,populationContacts:population.contact_total,
        businessesScanned:0,contactsScanned:0,businessesChanged:0,contactsChanged:0,
        verifiedCycles:Number(state.verifiedCycles ?? 0)};
    }
    type Lane = "business" | "contact";
    const runLane = async (lane: Lane, startCursor: number, highWater: number, cap: number, budgetMs: number,
      sizing: { start: number; max: number }, startSlice: number) => {
      let cursor = startCursor, slice = Math.min(sizing.max, Math.max(MIN_SLICE, startSlice));
      let processed = 0, changed = 0, timedOut = 0;
      const startedAt = Date.now();
      while (processed < cap && (processed === 0 || Date.now() - startedAt < budgetMs)) {
        const take = Math.min(slice, cap - processed);
        const sliceStartedAt = Date.now();
        let outcome: { page: any[]; changed: number };
        try {
          outcome = await tx.transaction(async sp => {
            await sp.execute(sql`SELECT set_config('statement_timeout',${`${sliceTimeoutMs}ms`},true)`);
            const stall = options.faultInjection?.(lane, take) ?? 0;
            if (stall > 0) await sp.execute(sql`SELECT pg_sleep(${stall / 1000})`);
            const page = lane === "business"
              ? rows(await sp.execute(sql`SELECT b.id,
                  ${sql.raw(effectiveBusinessVerticalSql("b"))} AS vertical,
                  ${sql.raw(effectiveBusinessVerticalStatusSql("b"))} AS status
                  FROM businesses b WHERE b.id>${cursor} AND b.id<=${Number(highWater)}
                  ORDER BY b.id LIMIT ${take}`))
              : rows(await sp.execute(sql`SELECT c.id,
                  ${sql.raw(effectiveContactVerticalSql("c"))} AS vertical,
                  ${sql.raw(effectiveContactVerticalStatusSql("c"))} AS status
                  FROM contacts c WHERE c.id>${cursor} AND c.id<=${Number(highWater)}
                  ORDER BY c.id LIMIT ${take}`));
            if (!page.length) return { page, changed: 0 };
            const values = sql.join(page.map((r: any) =>
              sql`(${r.id}::integer,${r.vertical}::text,${r.status}::text)`), sql`, `);
            const updated = lane === "business"
              ? rows(await sp.execute(sql`UPDATE businesses b SET effective_vertical_id=v.vertical,
                  effective_vertical_status=v.status
                  FROM (VALUES ${values}) v(id,vertical,status) WHERE b.id=v.id
                    AND (b.effective_vertical_id,b.effective_vertical_status) IS DISTINCT FROM (v.vertical,v.status)
                  RETURNING b.id`))
              : rows(await sp.execute(sql`UPDATE contacts c SET effective_vertical_id=v.vertical,
                  effective_vertical_status=v.status
                  FROM (VALUES ${values}) v(id,vertical,status) WHERE c.id=v.id
                    AND (c.effective_vertical_id,c.effective_vertical_status) IS DISTINCT FROM (v.vertical,v.status)
                  RETURNING c.id`));
            return { page, changed: updated.length };
          });
        } catch (error: any) {
          // 57014 = statement timeout/cancel. The savepoint already rolled that slice back; retry smaller.
          if (sqlStateOf(error) === "57014" && slice > MIN_SLICE) {
            slice = Math.max(MIN_SLICE, Math.floor(slice / 2));
            timedOut++;
            continue;
          }
          throw error;
        }
        if (!outcome.page.length) break;
        cursor = Number(outcome.page.at(-1).id);
        processed += outcome.page.length;
        changed += outcome.changed;
        const elapsed = Date.now() - sliceStartedAt;
        if (elapsed > sliceTimeoutMs / 2) slice = Math.max(MIN_SLICE, Math.floor(slice / 2));
        else if (elapsed < sliceTimeoutMs / 8 && outcome.page.length === take) slice = Math.min(sizing.max, slice * 2);
        if (outcome.page.length < take) break;
      }
      return { cursor, processed, changed, timedOut, slice };
    };
    const business = await runLane("business", Number(state.businessCursor ?? 0), Number(state.businessHighWater),
      pageLimit, businessBudgetMs, BUSINESS_SLICE, num(state.businessSlice, BUSINESS_SLICE.start));
    const contact = await runLane("contact", Number(state.contactCursor ?? 0), Number(state.contactHighWater),
      pageLimit, contactBudgetMs, CONTACT_SLICE, num(state.contactSlice, CONTACT_SLICE.start));
    const complete = business.processed === 0 && contact.processed === 0;
    const next = {...state,businessCursor: business.cursor,
      contactCursor: contact.cursor,
      businessSlice: business.slice, contactSlice: contact.slice,
      slowSlices: Number(state.slowSlices ?? 0) + business.timedOut + contact.timedOut,
      cycles: Number(state.cycles ?? 0)+(complete ? 1 : 0),
      verifiedCycles:Number(state.verifiedCycles ?? 0)+(complete ? 1 : 0),
      businessesScanned:Number(state.businessesScanned)+business.processed,
      contactsScanned:Number(state.contactsScanned)+contact.processed,
      businessesChanged:Number(state.businessesChanged)+business.changed,
      contactsChanged:Number(state.contactsChanged)+contact.changed,
      businessChanged:business.changed,contactChanged:contact.changed,lastCompletedAt: complete ? new Date().toISOString() : state.lastCompletedAt ?? null,
      lastTickAt: new Date().toISOString(),
      outboundChanges: 0,providerCalls: 0 };
    if (complete) {
      next.lastCompletedCoverage={
        scope:next.scope,startedAt:next.scanStartedAt,completedAt:next.lastCompletedAt,
        businessHighWater:next.businessHighWater,contactHighWater:next.contactHighWater,
        populationBusinesses:next.populationBusinesses,populationContacts:next.populationContacts,
        businessesScanned:next.businessesScanned,contactsScanned:next.contactsScanned,
        businessesChanged:next.businessesChanged,contactsChanged:next.contactsChanged,
      };
      next.scanStartedAt=null;
      next.businessCursor = 0; next.contactCursor = 0;
    }
    await tx.execute(sql`UPDATE system_settings SET value=${JSON.stringify(next)}::jsonb,
      updated_at=NOW() WHERE key=${KEY}`);
    return { ran: true,...next };
  });
}