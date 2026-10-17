/**
 * Request and credit allowance for the pre-classification ("unlabeled") Serper discovery
 * scope. The scope ships disabled: it runs only when an admin setting enables it with
 * positive per-run request, daily request, daily CREDIT and per-request credit-bound
 * values. Any missing, malformed or non-positive value keeps it closed. A request-only
 * setting (including the old `dailyReportedCredits` key) cannot enforce a credit ceiling,
 * so it is closed rather than treated as a cap.
 *
 * Every physical provider request goes through a durable shared ledger
 * (`sfp_serper_credit_ledger`):
 *  - BEFORE the request, under one advisory lock for the allowance, the worst-case charge
 *    (the larger of the configured per-request bound and the largest credit charge the
 *    provider has ever reported for that endpoint) is reserved. The request is authorized
 *    only if the reserved total, plus this reservation, stays within the daily credit cap
 *    and the daily request cap. Concurrent runs serialize on the same lock.
 *  - AFTER the request, a reported charge replaces the reservation. A missing or unparsable
 *    charge stays at the reserved worst case ("unknown", never zero). A request that never
 *    reached the provider is released. A crash leaves the reservation in place.
 *  - If the ledger cannot be read or written, the request is NOT sent (fail closed).
 * Attempt telemetry is diagnostic only and is never the spending authority. No per-request
 * credit factor is assumed beyond the operator-supplied bound and measured provider reports.
 * The ordinary target-vertical scope is not affected by this module.
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";

const rows = (r: any): any[] => r?.rows ?? r ?? [];

export const UNLABELED_DISCOVERY_SETTING_KEY = "sfp_serper_unlabeled_discovery";
/** Telemetry caller tag (diagnostic reporting only). */
export const UNLABELED_DISCOVERY_CALLER = "server/services/cro03/sfp-paid-waterfall.ts#unlabeled";
/** The ledger partition shared by every run of this scope. */
export const UNLABELED_DISCOVERY_ALLOWANCE_KEY = "serper_unlabeled_discovery";

export interface UnlabeledDiscoveryGate {
  enabled: boolean;
  perRunRequests: number;
  dailyRequests: number;
  /** Hard ceiling on credits reserved or settled in the last 24 hours. */
  dailyCredits: number;
  /** Operator-supplied worst-case credits for one request (raised by measured provider reports). */
  maxCreditsPerRequest: number;
}

const CLOSED: UnlabeledDiscoveryGate = {
  enabled: false, perRunRequests: 0, dailyRequests: 0, dailyCredits: 0, maxCreditsPerRequest: 0,
};

const positiveInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;

/** Parse a stored setting value; anything but a fully valid enabled value is closed. */
export function parseUnlabeledDiscoveryGate(value: unknown): UnlabeledDiscoveryGate {
  if (!value || typeof value !== "object") return CLOSED;
  const v = value as Record<string, unknown>;
  if (v.enabled !== true) return CLOSED;
  const perRunRequests = positiveInt(v.perRunRequests);
  const dailyRequests = positiveInt(v.dailyRequests);
  const dailyCredits = positiveInt(v.dailyCredits);
  const maxCreditsPerRequest = positiveInt(v.maxCreditsPerRequest);
  if (!perRunRequests || !dailyRequests || !dailyCredits || !maxCreditsPerRequest) return CLOSED;
  // A single request that cannot fit the daily cap could never be authorized; reject the setting.
  if (maxCreditsPerRequest > dailyCredits) return CLOSED;
  return { enabled: true, perRunRequests, dailyRequests, dailyCredits, maxCreditsPerRequest };
}

export async function readUnlabeledDiscoveryGate(): Promise<UnlabeledDiscoveryGate> {
  const row = rows(await db.execute(sql`
    SELECT value FROM system_settings WHERE key=${UNLABELED_DISCOVERY_SETTING_KEY} LIMIT 1
  `))[0];
  return parseUnlabeledDiscoveryGate(row?.value);
}

type Executor = { execute: (query: any) => Promise<any> };

/** Requests and credits counted against the last 24 hours: reserved worst case until a charge is known. */
export async function readUnlabeledDiscoveryLedgerUsage(
  executor: Executor = db,
): Promise<{ requests: number; credits: number; unknownChargeRequests: number }> {
  const row = rows(await executor.execute(sql`
    SELECT COUNT(*) FILTER (WHERE state<>'not_sent')::integer AS requests,
           COALESCE(SUM(COALESCE(settled_credits,reserved_credits)) FILTER (WHERE state<>'not_sent'),0)::integer AS credits,
           COUNT(*) FILTER (WHERE state IN ('reserved','settled_unknown'))::integer AS unknown_charge
      FROM sfp_serper_credit_ledger
     WHERE allowance_key=${UNLABELED_DISCOVERY_ALLOWANCE_KEY} AND created_at>NOW()-INTERVAL '24 hours'
  `))[0];
  return {
    requests: Number(row?.requests ?? 0),
    credits: Number(row?.credits ?? 0),
    unknownChargeRequests: Number(row?.unknown_charge ?? 0),
  };
}

/** Largest per-request charge the provider has reported for this endpoint (measured, not assumed). */
async function observedMaxCharge(executor: Executor, endpoint: string): Promise<number> {
  const row = rows(await executor.execute(sql`
    SELECT COALESCE(MAX(reported_credits),0)::integer AS m FROM serper_lookup_attempts
     WHERE endpoint=${endpoint.slice(0, 20)} AND reported_credits IS NOT NULL
       AND created_at>NOW()-INTERVAL '30 days'
  `))[0];
  return Number(row?.m ?? 0);
}

export type AllowanceDenial = "per_run_requests" | "daily_requests" | "daily_credits" | "allowance_unavailable";

export interface RequestAllowance {
  /** Read-only: could at least one more request be authorized now? Never reserves. */
  canStart: () => Promise<boolean>;
  /** Reserve the worst-case charge for one physical request; false means do not send it. */
  authorizeRequest: (request: { endpoint: string }) => Promise<boolean>;
  /** Record the reported charge (null = unknown, stays at the reserved worst case). */
  onRequestSettled: (info: { endpoint: string; reportedCredits: number | null }) => Promise<void>;
  /** The authorized request was blocked locally and never reached the provider. */
  onRequestNotSent: (info: { endpoint: string }) => Promise<void>;
  snapshot: () => {
    runRequests: number;
    reservedWorstCaseCredits: number;
    settledKnownCredits: number;
    unknownChargeRequests: number;
    notSentRequests: number;
    denial: AllowanceDenial | null;
  };
}

export function createDurableRequestAllowance(
  gate: UnlabeledDiscoveryGate,
  runToken: string,
  executor: Executor & { transaction: (fn: (tx: any) => Promise<any>) => Promise<any> } = db as any,
): RequestAllowance {
  let runRequests = 0;
  let reservedWorstCase = 0;
  let settledKnown = 0;
  let unknownCharge = 0;
  let notSent = 0;
  let denial: AllowanceDenial | null = null;
  let pending: { id: string; reserved: number } | null = null;

  const evaluate = async (tx: Executor, endpoint: string) => {
    if (!gate.enabled) return { ok: false as const, reason: "allowance_unavailable" as AllowanceDenial, bound: 0 };
    if (runRequests >= gate.perRunRequests) return { ok: false as const, reason: "per_run_requests" as AllowanceDenial, bound: 0 };
    const bound = Math.max(gate.maxCreditsPerRequest, await observedMaxCharge(tx, endpoint), 1);
    const usage = await readUnlabeledDiscoveryLedgerUsage(tx);
    if (usage.requests + 1 > gate.dailyRequests) return { ok: false as const, reason: "daily_requests" as AllowanceDenial, bound };
    if (usage.credits + bound > gate.dailyCredits) return { ok: false as const, reason: "daily_credits" as AllowanceDenial, bound };
    return { ok: true as const, bound };
  };

  return {
    canStart: async () => {
      try {
        // The widest endpoint bound is the conservative planning figure for a lookup's first request.
        const result = await evaluate(executor, "/places");
        if (!result.ok) denial = result.reason;
        return result.ok;
      } catch {
        denial = "allowance_unavailable";
        return false;
      }
    },
    authorizeRequest: async ({ endpoint }) => {
      try {
        const outcome = await executor.transaction(async (tx: any) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${"sfp_serper_allowance:" + UNLABELED_DISCOVERY_ALLOWANCE_KEY},0))`);
          const result = await evaluate(tx, endpoint);
          if (!result.ok) return result;
          const inserted = rows(await tx.execute(sql`
            INSERT INTO sfp_serper_credit_ledger(allowance_key,run_token,endpoint,reserved_credits,state)
            VALUES(${UNLABELED_DISCOVERY_ALLOWANCE_KEY},${runToken}::uuid,${endpoint.slice(0, 20)},${result.bound},'reserved')
            RETURNING id`))[0];
          return { ok: true as const, bound: result.bound, id: String(inserted.id) };
        });
        if (!outcome.ok) { denial = outcome.reason; return false; }
        // A previous request whose settlement never ran stays reserved at its worst case.
        pending = { id: (outcome as any).id, reserved: outcome.bound };
        runRequests++;
        reservedWorstCase += outcome.bound;
        return true;
      } catch {
        // Ledger unavailable: fail closed, never send an unreserved request.
        denial = "allowance_unavailable";
        return false;
      }
    },
    onRequestSettled: async ({ reportedCredits }) => {
      const current = pending;
      pending = null;
      if (!current) return;
      try {
        if (reportedCredits === null) {
          unknownCharge++;
          await executor.execute(sql`UPDATE sfp_serper_credit_ledger SET state='settled_unknown',settled_at=NOW()
            WHERE id=${current.id}::uuid AND state='reserved'`);
        } else {
          settledKnown += reportedCredits;
          await executor.execute(sql`UPDATE sfp_serper_credit_ledger SET state='settled',settled_credits=${reportedCredits},settled_at=NOW()
            WHERE id=${current.id}::uuid AND state='reserved'`);
        }
      } catch {
        // The reservation remains at its worst case, which is the conservative state.
        unknownCharge++;
      }
    },
    onRequestNotSent: async () => {
      const current = pending;
      pending = null;
      if (!current) return;
      notSent++;
      runRequests = Math.max(0, runRequests - 1);
      reservedWorstCase = Math.max(0, reservedWorstCase - current.reserved);
      try {
        await executor.execute(sql`UPDATE sfp_serper_credit_ledger SET state='not_sent',settled_credits=0,settled_at=NOW()
          WHERE id=${current.id}::uuid AND state='reserved'`);
      } catch {
        // Stays reserved: over-counts rather than under-counts.
      }
    },
    snapshot: () => ({
      runRequests, reservedWorstCaseCredits: reservedWorstCase, settledKnownCredits: settledKnown,
      unknownChargeRequests: unknownCharge, notSentRequests: notSent, denial,
    }),
  };
}
