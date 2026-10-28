/**
 * Shared paid-provider control-plane views and the operator emergency stop.
 *
 * This module is deliberately transport-free: it only reads and mutates the
 * disposable/durable control tables. Provider adapters remain responsible for
 * their own fake-transport boundaries.
 */
import { sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { auditLogs } from "@shared/schema";
import { PROVIDER_SOURCE_MANIFEST } from "./provider-manifest";
import { sanitizeAuditPayload } from "./audit-sanitizer";

export const PAID_PROVIDER_KEYS = ["serper", "outscraper", "openai", "apollo", "zerobounce"] as const;
export type PaidProviderKey = (typeof PAID_PROVIDER_KEYS)[number];

const SECRET_BY_PROVIDER: Record<PaidProviderKey, string> = {
  serper: "SERPER_API_KEY",
  outscraper: "OUTSCRAPER_API_KEY",
  openai: "AI_INTEGRATIONS_OPENAI_API_KEY",
  apollo: "APOLLO_API_KEY",
  zerobounce: "ZEROBOUNCE_API_KEY",
};

const CAPABILITY_BY_PROVIDER: Record<PaidProviderKey, string> = {
  serper: "business_discovery",
  outscraper: "business_discovery",
  openai: "cro03_classification",
  apollo: "contact_enrichment",
  zerobounce: "email_validation",
};
const CALLERS_BY_PROVIDER: Record<PaidProviderKey, string[]> = {
  serper: ["server/services/sdr/serper-enrichment.ts", "server/services/sdr/lead-finder.ts", "server/services/cro03/live-provider-executors.ts", "server/services/serper-business-identity.ts"],
  outscraper: ["server/services/cro03/live-provider-executors.ts"],
  openai: ["server/services/cro03/live-provider-executors.ts"],
  apollo: ["server/services/cro03/live-provider-executors.ts"],
  zerobounce: ["server/services/zerobounce-campaign-worker.ts", "server/services/cro03/live-provider-executors.ts", "server/services/cro03/business-validation-service.ts"],
};

function rows(result: any): any[] {
  return result?.rows ?? [];
}

export type ZeroBounceAutoRunState = "disabled" | "scheduled" | "schedule_unresolved" | "unavailable";

/**
 * Next automatic ZeroBounce run. `cron` is the effective schedule (ZEROBOUNCE_AUTO_RUN_CRON override, default
 * "0 6 * * *"). Only fixed-time daily patterns ("M H * * *", UTC) are resolved here; any other expression is reported
 * as schedule_unresolved with a null time rather than a guessed one. A disabled auto-run never has a next run.
 */
export function resolveZeroBounceNextRun(input: {
  autoRunEnabled: boolean | null;
  cron: string;
  now?: Date;
}): { state: ZeroBounceAutoRunState; nextAutomaticRunAt: string | null; schedule: string } {
  const schedule = input.cron.trim();
  if (input.autoRunEnabled === null) return { state: "unavailable", nextAutomaticRunAt: null, schedule };
  if (!input.autoRunEnabled) return { state: "disabled", nextAutomaticRunAt: null, schedule };
  const m = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(schedule);
  const minute = m ? Number(m[1]) : NaN;
  const hour = m ? Number(m[2]) : NaN;
  if (!m || minute > 59 || hour > 23) return { state: "schedule_unresolved", nextAutomaticRunAt: null, schedule };
  const now = input.now ?? new Date();
  const next = new Date(now);
  next.setUTCHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return { state: "scheduled", nextAutomaticRunAt: next.toISOString(), schedule };
}

/**
 * A panel-safe snapshot. Secret values are never returned; missing control
 * rows are represented explicitly rather than treated as enabled.
 */
/** Display bound for the in-flight operation list (the count is never bounded). */
export const IN_FLIGHT_SAMPLE_LIMIT = 100;

export async function getPaidProviderControls(): Promise<{
  providers: Array<Record<string, unknown>>;
  zeroBounce: Record<string, unknown>;
  inFlightCount: number;
  inFlightOperations: Array<Record<string, unknown>>;
  /** inFlightOperations is a bounded sample; inFlightCount is the whole-population count. */
  inFlightSample: { limit: number; returned: number; total: number; truncated: boolean; scope: string; asOf: string };
}> {
  const controls = rows(await db.execute(sql`
    SELECT provider, capability, enabled, circuit_state,
           reserved_units, consumed_units, last_completed_at, last_outcome,
           last_error_code, observed_at, updated_at
      FROM provider_controls
     WHERE provider IN ('serper', 'outscraper', 'openai', 'apollo', 'zerobounce')
  `));
  const inFlightOperations = rows(await db.execute(sql`
    SELECT id, provider, operation_type, purpose, state, billing_state,
           requested_units, reserved_units, created_at, started_at
      FROM provider_operations
     WHERE provider IN ('serper', 'outscraper', 'openai', 'apollo', 'zerobounce')
       AND (state IN ('pending', 'deferred', 'running') OR billing_state IN ('reserved','ambiguous'))
     ORDER BY created_at ASC
     LIMIT ${IN_FLIGHT_SAMPLE_LIMIT}
  `));
  // Whole-population count, independent of the displayed sample.
  const inFlightTotal = Number(rows(await db.execute(sql`
    SELECT COUNT(*)::int AS n
      FROM provider_operations
     WHERE provider IN ('serper', 'outscraper', 'openai', 'apollo', 'zerobounce')
       AND (state IN ('pending', 'deferred', 'running') OR billing_state IN ('reserved','ambiguous'))
  `))[0]?.n ?? 0);
  const sfpCostRows = rows(await db.execute(sql`
    SELECT o.provider,
           COALESCE(SUM(settled_cost_micros) FILTER (WHERE settled_cost_micros IS NOT NULL), 0)::bigint AS settled_micros,
           COUNT(*) FILTER (WHERE o.settled_cost_micros IS NOT NULL)::int AS settled_cost_records,
           COALESCE(SUM(CASE WHEN o.billing_state = 'reserved' AND price.amount_micros IS NOT NULL
                             THEN o.reserved_units::bigint * price.amount_micros ELSE 0 END), 0)::bigint AS reserved_micros,
           COUNT(*) FILTER (WHERE price.amount_micros IS NULL)::int AS unpriced_operations,
           COUNT(*) FILTER (WHERE o.billing_state='ambiguous')::int AS ambiguous_operations
      FROM provider_operations o
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN o.unit_price_micros IS NOT NULL THEN o.unit_price_micros
          WHEN o.sfp_result_data->>'reservedUnitAmountMicros' ~ '^[0-9]+$'
            THEN (o.sfp_result_data->>'reservedUnitAmountMicros')::bigint
          ELSE NULL
        END AS amount_micros
      ) AS price
     WHERE o.operation_type IN ('sfp_enrichment', 'sfp_precohort_classification')
     GROUP BY o.provider
  `));
  const byProvider = new Map(controls.map((row) => [String(row.provider), row]));
  const sfpCostsByProvider = new Map(sfpCostRows.map((row) => [String(row.provider), row]));

  let serper: any = null;
  try {
    serper = rows(await db.execute(sql`
      SELECT enabled, state, window_calls, last_success_at,
             last_failure_at, reason_code, updated_at
        FROM serper_control WHERE id = 1
    `))[0] ?? null;
  } catch {
    // A missing/unmigrated control row is represented as unavailable below.
  }

  let pricing: Record<string, any> = {};
  let pricingAvailable = true;
  let pricingArtifactRefs = new Map<string, string>();
  let pricingSnapshotId: string | null = null;
  try {
    const { getCurrentPricingSchedule } = await import("./mi09-pilot-authority");
    const schedule = await getCurrentPricingSchedule();
    pricingSnapshotId = schedule.snapshotId;
    pricing = schedule.priceSchedules as Record<string, any>;
    try {
      const artifacts = rows(await db.execute(sql`
        SELECT provider_key, id, artifact_version
          FROM mi09_pricing_artifacts
         WHERE provider_key IN ('serper', 'outscraper', 'openai', 'apollo', 'zerobounce')
         ORDER BY captured_at DESC
      `));
      for (const artifact of artifacts) {
        if (!pricingArtifactRefs.has(String(artifact.provider_key))) {
          pricingArtifactRefs.set(
            String(artifact.provider_key),
            `mi09_pricing_artifacts:${artifact.id}:v${artifact.artifact_version}`,
          );
        }
      }
    } catch {
      // The schedule remains useful in a partially migrated disposable DB;
      // expose its stable snapshot reference below instead.
    }
  } catch {
    pricingAvailable = false;
  }

  const providers = PAID_PROVIDER_KEYS.map((provider) => {
    const row = byProvider.get(provider);
    const circuitState = provider === "serper"
      ? (serper?.state ?? row?.circuit_state ?? "unavailable")
      : (row?.circuit_state ?? "unavailable");
    const enabled = provider === "serper"
      ? (serper?.enabled === true && row?.enabled !== false)
      : row?.enabled === true;
    const price = pricing[provider];
    const manifest = PROVIDER_SOURCE_MANIFEST.find((entry) => entry.id === provider);
    const canonicalConsumedUnits = Number(row?.consumed_units ?? 0);
    const gatewayConsumedUnits = provider === "serper" ? Number(serper?.window_calls ?? 0) : 0;
    const sfpCost = sfpCostsByProvider.get(provider);
    return {
      provider,
      credentialPresent: Boolean(process.env[SECRET_BY_PROVIDER[provider]]),
      enabled,
      circuitState,
      reservedUnits: row?.reserved_units ?? 0,
      consumedUnits: provider === "serper" ? Math.max(canonicalConsumedUnits, gatewayConsumedUnits) : canonicalConsumedUnits,
      providerControlConsumedUnits: canonicalConsumedUnits,
      gatewayConsumedUnits,
      // These are schedule-based estimates, not provider invoices. NULL means
      // the operation writer has not recorded per-operation settlement data.
      sfpSettledCostEstimateMicros: Number(sfpCost?.settled_cost_records ?? 0) > 0
        ? Number(sfpCost.settled_micros)
        : null,
      sfpSettledCostEstimateRecordCount: Number(sfpCost?.settled_cost_records ?? 0),
      sfpReservedCostEstimateMicros: Number(sfpCost?.reserved_micros ?? 0),
      sfpUnpricedOperationCount: Number(sfpCost?.unpriced_operations ?? 0),
      sfpAmbiguousOperationCount: Number(sfpCost?.ambiguous_operations ?? 0),
      currentPriceArtifactReference: pricingAvailable && price
        ? (pricingArtifactRefs.get(provider) ?? `mi09_pricing_schedule_snapshots:${pricingSnapshotId}:${provider}:v${price.version}`)
        : null,
      currentPrice: price ?? null,
      lastCallAt: row?.last_completed_at ?? serper?.last_success_at ?? serper?.last_failure_at ?? null,
      lastOutcome: row?.last_outcome ?? (serper?.last_failure_at ? `failure:${serper.reason_code ?? "unknown"}` : serper?.last_success_at ? "success" : null),
      lastErrorCode: row?.last_error_code ?? serper?.reason_code ?? null,
      authorizedPurposes: manifest?.capability ?? [CAPABILITY_BY_PROVIDER[provider]],
      authorizedCallers: manifest?.approvedCallers ?? CALLERS_BY_PROVIDER[provider],
      controlRowPresent: Boolean(row),
    };
  });

  let autoRunEnabled: boolean | null = null;
  try {
    const autoRunValue = await storage.getSystemSetting("zerobounce_auto_run_enabled");
    autoRunEnabled = autoRunValue === true || autoRunValue === "true";
  } catch { autoRunEnabled = null; }
  const nextRun = resolveZeroBounceNextRun({ autoRunEnabled, cron: process.env.ZEROBOUNCE_AUTO_RUN_CRON ?? "0 6 * * *" });
  const zb = providers.find((provider) => provider.provider === "zerobounce")!;
  return {
    providers,
    zeroBounce: {
      enabled: zb.enabled,
      circuitState: zb.circuitState,
      autoRunEnabled,
      autoRunState: nextRun.state,
      autoRunSchedule: nextRun.schedule,
      nextAutomaticRunAt: nextRun.nextAutomaticRunAt,
      authorizedPurposes: zb.authorizedPurposes,
      authorizedCallers: zb.authorizedCallers,
    },
    inFlightCount: inFlightTotal,
    inFlightOperations,
    inFlightSample: {
      limit: IN_FLIGHT_SAMPLE_LIMIT,
      returned: inFlightOperations.length,
      total: inFlightTotal,
      truncated: inFlightTotal > inFlightOperations.length,
      scope: "oldest in-flight paid-provider operations; the list is a sample, the count is the whole population",
      asOf: new Date().toISOString(),
    },
  };
}

/**
 * Audited operator enable/disable switch for SFP provider execution.
 * Enablement never changes provider usage counters or circuit state and does
 * not impose a monetary or credit ceiling. Actual operations still require
 * their independent approval, pause, manifest, and last-mile authority gates.
 */
export async function updateSfpPaidProviderControl(input: {
  provider: PaidProviderKey;
  enabled: boolean;
  reason: string;
  actorId: string;
}): Promise<Record<string, unknown>> {
  if (typeof input.enabled !== "boolean") throw new Error("PROVIDER_ENABLED_BOOLEAN_REQUIRED");
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 8 || reason.length > 200) throw new Error("PROVIDER_CONTROL_REASON_REQUIRED");

  if (input.enabled) {
    if (process.env.CRO03_PROVIDER_TRANSPORT_ENABLED !== "true") throw new Error("PROVIDER_TRANSPORT_DISABLED");
    if (!process.env[SECRET_BY_PROVIDER[input.provider]]) throw new Error(`PROVIDER_CREDENTIAL_MISSING:${SECRET_BY_PROVIDER[input.provider]}`);
  }

  return db.transaction(async (tx) => {
    const current = rows(await tx.execute(sql`
      SELECT provider,enabled,circuit_state,reserved_units,consumed_units,version
        FROM provider_controls WHERE provider=${input.provider} FOR UPDATE
    `))[0];
    if (!current) throw new Error(`PROVIDER_CONTROL_NOT_FOUND:${input.provider}`);

    let gateway: any = null;
    if (input.provider === "serper") {
      gateway = rows(await tx.execute(sql`
        SELECT enabled,state,window_calls FROM serper_control WHERE id=1 FOR UPDATE
      `))[0];
      if (!gateway) throw new Error("SERPER_GATEWAY_CONTROL_NOT_FOUND");
    }

    if (input.enabled && current.circuit_state !== "closed") throw new Error(`PROVIDER_CIRCUIT_NOT_CLOSED:${current.circuit_state}`);
    if (input.enabled && input.provider === "serper" && gateway.state !== "closed") throw new Error(`SERPER_GATEWAY_CIRCUIT_NOT_CLOSED:${gateway.state}`);

    const updated = rows(await tx.execute(sql`
      UPDATE provider_controls
         SET enabled=${input.enabled},
             version=version+1,updated_at=NOW()
       WHERE provider=${input.provider}
       RETURNING provider,enabled,circuit_state,reserved_units,consumed_units,version
    `))[0];

    if (input.provider === "serper") {
      await tx.execute(sql`
        UPDATE serper_control
           SET enabled=${input.enabled},
               updated_at=NOW()
         WHERE id=1
      `);
    }

    const auditPayload = sanitizeAuditPayload({
      provider: input.provider,
      enabled: input.enabled,
      reason,
      providerConsumedUnits: current.consumed_units,
      providerReservedUnits: current.reserved_units,
      gatewayConsumedUnits: input.provider === "serper" ? Number(gateway?.window_calls ?? 0) : null,
    });
    await tx.execute(sql`
      INSERT INTO audit_logs (user_id,action,entity_type,entity_key,details,before_state,after_state,actor_type,actor_id)
      VALUES (${input.actorId},'sfp_provider_control_changed','provider_control',${input.provider},
              ${JSON.stringify(auditPayload)}::jsonb,
              ${JSON.stringify({ enabled: current.enabled, circuitState: current.circuit_state, consumedUnits: current.consumed_units, reservedUnits: current.reserved_units, gatewayConsumedUnits: input.provider === "serper" ? Number(gateway?.window_calls ?? 0) : null })}::jsonb,
              ${JSON.stringify(updated)}::jsonb,'user',${input.actorId})
    `);
    return {
      ...updated,
      gatewayConsumedUnits: input.provider === "serper" ? Number(gateway?.window_calls ?? 0) : null,
    };
  });
}

/**
 * Disable every paid provider atomically and leave already-dispatched work
 * visible for reconciliation. Pending/running rows are not silently deleted
 * or marked terminal; they receive a cancellation request and are returned.
 */
export async function emergencyStopPaidProviders(input: {
  stoppedBy: string;
  reason: string;
}): Promise<{
  providersDisabled: number;
  inFlightCount: number;
  inFlightOperations: Array<Record<string, unknown>>;
  schedulesDeactivated: number;
}> {
  return db.transaction(async (tx) => {
    const inflight = rows(await tx.execute(sql`
      SELECT id, provider, operation_type, purpose, state, billing_state,
             requested_units, reserved_units, created_at, started_at
        FROM provider_operations
       WHERE provider IN ('serper', 'outscraper', 'openai', 'apollo', 'zerobounce')
         AND (state IN ('pending', 'deferred', 'running') OR billing_state = 'reserved')
       ORDER BY created_at ASC
       FOR UPDATE
    `));

    const disabled = await tx.execute(sql`
      UPDATE provider_controls
         SET enabled = FALSE, circuit_state = 'open', last_outcome = 'emergency_stop',
             last_error_code = 'operator_emergency_stop', version = version + 1, updated_at = NOW()
       WHERE provider IN ('serper', 'outscraper', 'openai', 'apollo', 'zerobounce')
    `);

    // Serper has a legacy singleton gateway row in addition to provider_controls.
    await tx.execute(sql`
      UPDATE serper_control
         SET enabled = FALSE, state = 'open', reason_code = 'operator_emergency_stop',
             half_open_probe_claimed_at = NULL, updated_at = NOW()
       WHERE id = 1
    `);

    // These are independent switches: stopping MI-09/paid controls must also
    // turn off the automatic ZeroBounce lane, without changing manual settings.
    await tx.execute(sql`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES ('zerobounce_auto_run_enabled', 'false'::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE SET value = 'false'::jsonb, updated_at = NOW()
    `);
    await tx.execute(sql`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES ('cro08a_recurring_enrichment_enabled', 'false'::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE SET value = 'false'::jsonb, updated_at = NOW()
    `);

    const deactivated = rows(await tx.execute(sql`
      UPDATE cro08a_schedule_definitions
         SET active = FALSE, updated_at = NOW()
       WHERE active = TRUE
       RETURNING id
    `));

    // Emergency stop also revokes recurring paid approval (not just deactivates
    // schedules), so a future
    // re-activation can never silently ride on a stale operator confirmation
    // — the operator must explicitly re-type the recurring confirmation.
    await tx.execute(sql`
      UPDATE system_settings
         SET value = jsonb_set(jsonb_set(jsonb_set(value,
               '{revokedAt}', to_jsonb(NOW()::text)),
               '{revokedBy}', to_jsonb(${input.stoppedBy}::text)),
               '{revokedReason}', to_jsonb(${input.reason}::text))
       WHERE key = 'cro08a_recurring_paid_budget_authorization'
         AND value->>'revokedAt' IS NULL
    `);

    if (inflight.length > 0) {
      await tx.execute(sql`
        UPDATE provider_operations
           SET cancel_requested_at = COALESCE(cancel_requested_at, NOW()), updated_at = NOW()
         WHERE provider IN ('serper', 'outscraper', 'openai', 'apollo', 'zerobounce')
           AND (state IN ('pending', 'deferred', 'running') OR billing_state = 'reserved')
      `);
    }

    await tx.insert(auditLogs).values({
      action: "paid_provider_emergency_stop",
      entityType: "system",
      entityKey: "paid-providers",
      actorType: "user",
      actorId: input.stoppedBy,
      userId: input.stoppedBy,
      details: sanitizeAuditPayload({
        reason: input.reason,
        providers: PAID_PROVIDER_KEYS,
        inFlightCount: inflight.length,
        schedulesDeactivated: deactivated.length,
      }) as Record<string, unknown>,
    });

    return {
      providersDisabled: Number((disabled as any).rowCount ?? 0),
      inFlightCount: inflight.length,
      inFlightOperations: inflight,
      schedulesDeactivated: deactivated.length,
    };
  });
}
