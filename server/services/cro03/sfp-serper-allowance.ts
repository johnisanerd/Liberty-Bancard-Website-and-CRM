/**
 * Request and credit allowance for the pre-classification ("unlabeled") Serper discovery
 * scope. The scope ships disabled: it runs only when an admin setting enables it AND
 * positive per-run and daily allowances are present. Any missing, malformed or
 * non-positive value keeps it closed.
 *
 * Allowances are checked before EVERY provider request (including the second and later
 * requests of one lookup). Requests and provider-reported credits are tracked separately;
 * no per-request credit factor is ever assumed. The ordinary target-vertical scope is not
 * affected by this module.
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";

const rows = (r: any): any[] => r?.rows ?? r ?? [];

export const UNLABELED_DISCOVERY_SETTING_KEY = "sfp_serper_unlabeled_discovery";
/** Telemetry caller tag; the daily usage below is summed over this tag only. */
export const UNLABELED_DISCOVERY_CALLER = "server/services/cro03/sfp-paid-waterfall.ts#unlabeled";

export interface UnlabeledDiscoveryGate {
  enabled: boolean;
  perRunRequests: number;
  dailyRequests: number;
  /** Optional cap on credits the provider reported charging in the last 24 hours. */
  dailyReportedCredits: number | null;
}

const CLOSED: UnlabeledDiscoveryGate = { enabled: false, perRunRequests: 0, dailyRequests: 0, dailyReportedCredits: null };

const positiveInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;

/** Parse a stored setting value; anything but a fully valid enabled value is closed. */
export function parseUnlabeledDiscoveryGate(value: unknown): UnlabeledDiscoveryGate {
  if (!value || typeof value !== "object") return CLOSED;
  const v = value as Record<string, unknown>;
  if (v.enabled !== true) return CLOSED;
  const perRunRequests = positiveInt(v.perRunRequests);
  const dailyRequests = positiveInt(v.dailyRequests);
  if (!perRunRequests || !dailyRequests) return CLOSED;
  const credits = v.dailyReportedCredits == null ? null : positiveInt(v.dailyReportedCredits);
  if (v.dailyReportedCredits != null && credits === null) return CLOSED;
  return { enabled: true, perRunRequests, dailyRequests, dailyReportedCredits: credits };
}

export async function readUnlabeledDiscoveryGate(): Promise<UnlabeledDiscoveryGate> {
  const row = rows(await db.execute(sql`
    SELECT value FROM system_settings WHERE key=${UNLABELED_DISCOVERY_SETTING_KEY} LIMIT 1
  `))[0];
  return parseUnlabeledDiscoveryGate(row?.value);
}

export async function readUnlabeledDiscoveryDailyUsage(): Promise<{ requests: number; reportedCredits: number }> {
  const row = rows(await db.execute(sql`
    SELECT COALESCE(SUM(billed_units),0)::integer AS requests,
           COALESCE(SUM(reported_credits),0)::integer AS credits
      FROM serper_lookup_attempts
     WHERE caller=${UNLABELED_DISCOVERY_CALLER} AND created_at>NOW()-INTERVAL '24 hours'
  `))[0];
  return { requests: Number(row?.requests ?? 0), reportedCredits: Number(row?.credits ?? 0) };
}

export interface RequestAllowance {
  /** True while at least one more request fits every allowance. */
  authorizeRequest: () => boolean;
  /** Record a request that reached the provider. */
  onRequestSettled: (info: { reportedCredits: number | null }) => void;
  snapshot: () => { runRequests: number; runReportedCredits: number };
}

export function createRequestAllowance(
  gate: UnlabeledDiscoveryGate,
  dailyUsage: { requests: number; reportedCredits: number },
): RequestAllowance {
  let runRequests = 0;
  let runReportedCredits = 0;
  return {
    authorizeRequest: () => {
      if (!gate.enabled) return false;
      if (runRequests >= gate.perRunRequests) return false;
      if (dailyUsage.requests + runRequests >= gate.dailyRequests) return false;
      if (gate.dailyReportedCredits !== null
          && dailyUsage.reportedCredits + runReportedCredits >= gate.dailyReportedCredits) return false;
      return true;
    },
    onRequestSettled: ({ reportedCredits }) => {
      runRequests++;
      if (reportedCredits !== null) runReportedCredits += reportedCredits;
    },
    snapshot: () => ({ runRequests, runReportedCredits }),
  };
}
