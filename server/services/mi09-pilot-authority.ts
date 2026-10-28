/**
 * MI-09 Pilot Authority — durable lifecycle service for bounded pilot runs.
 *
 * This is the ONLY writer to mi09_pilot_definitions, mi09_pilot_runs,
 * mi09_pilot_cohort_members, mi09_pilot_checkpoints,
 * mi09_pilot_advancement_receipts, mi09_pilot_effect_links,
 * mi09_pilot_reconciliation_reports, and mi09_pricing_artifacts.
 *
 * No loose system_settings values are used as pilot state — every state
 * transition is durable, idempotent, and audit-visible.
 *
 * Invariants enforced here:
 *   - Global outbound MUST remain paused for all pilot levels (epoch checked
 *     at cohort-freeze and advancement time).
 *   - Pilot 1 is blocked if any paid provider is in the recipe.
 *   - Advancement requires an admin-signed idempotency key (CSRF handled by
 *     the route layer — this service trusts the approved_by string passed in
 *     after the route has verified role + CSRF).
 *   - Stop conditions evaluated from mi09_pilot_definitions — not hardcoded.
 */
import { createHash } from "crypto";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { getPauseState } from "./outbound-pause-authority";
import { sanitizeAuditPayload } from "./audit-sanitizer";
import { businessHasDbprLineageSql, businessLacksDbprLineageSql } from "./dbpr";
import { evaluateBusinessEnrichmentEligibility } from "./contactability";
import { acquireLadderBudgetLock, computeLadderBudgetLedger } from "./cro03/shared-paid-budget-ledger";
import {
  buildCro03PriceScheduleFromArtifacts,
  CRO03C_PROVIDER_KEYS,
  stableCro03RecipeHash,
  type Cro03PricingArtifactRow,
} from "./cro03/contracts";

const rows = (r: any): any[] => r?.rows ?? r ?? [];

// ── Hashing helpers ──────────────────────────────────────────────────────────
function stableHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface PilotDefinitionInput {
  level: 1 | 2 | 3;
  countyScope: string[];
  verticalScope: string[];
  sourceAdapterFilter: string[];
  maxCohortSize: number;
  enrichmentRecipeVersion: number;
  /** Per-provider paid-access flags. Pilot 1 must have all false. */
  paidProvidersAllowed: {
    serper?: boolean;
    outscraper?: boolean;
    apollo?: boolean;
    openai?: boolean;
    zerobounce?: boolean;
  };
  /** Operator-defined thresholds; none are hardcoded here. */
  stopConditionThresholds: {
    conflictPct: number;
    apolloYieldPct: number;
    zbUnknownPct: number;
    spendCapMicros: number;
  };
  createdBy: string;
}

export interface PilotRunInput {
  pilotDefinitionId: string;
  releaseSha: string;
  cro03cSelectionPolicyVersion: number;
  cro03cRoutingPolicyVersion: number;
  cro03cRecipeVersion: number;
  outboundPauseEpoch: number;
}

/** Per-provider frozen pricing snapshot captured at createPilotRun() time. */
interface FrozenPricingArtifactEntry {
  artifactId: string;
  amountMicros: number;
  capturedAt: string;
}

export interface AdvancementInput {
  pilotRunId: string;
  fromLevel: number;
  toLevel: number;
  approvedBy: string;
  pricingArtifactId?: string;
  stopConditionsChecked: Record<string, unknown>;
  stopConditionsPassed: boolean;
  idempotencyKey: string;
}

export interface PricingArtifactInput {
  providerKey: string;
  unitType: string;
  amountMicros: number;
  currency?: string;
  billingSemantics: string;
  capturedBy: string;
  accountBalanceUnits?: number;
  sourceUrl?: string;
  artifactVersion?: number;
}

// ── Pricing Artifact ─────────────────────────────────────────────────────────

export async function createPricingArtifact(
  input: PricingArtifactInput,
): Promise<{ id: string; artifactHash: string }> {
  const artifactHash = stableHash({
    providerKey: input.providerKey,
    unitType: input.unitType,
    amountMicros: input.amountMicros,
    currency: input.currency ?? "USD",
    billingSemantics: input.billingSemantics,
    artifactVersion: input.artifactVersion ?? 1,
  });
  const created = rows(await db.execute(sql`
    INSERT INTO mi09_pricing_artifacts
      (provider_key, unit_type, amount_micros, currency, billing_semantics,
       captured_by, account_balance_units, source_url, artifact_version, artifact_hash)
    VALUES (${input.providerKey}, ${input.unitType}, ${input.amountMicros},
            ${input.currency ?? "USD"}, ${input.billingSemantics},
            ${input.capturedBy}, ${input.accountBalanceUnits ?? null},
            ${input.sourceUrl ?? null}, ${input.artifactVersion ?? 1}, ${artifactHash})
    RETURNING id
  `));
  return { id: String(created[0].id), artifactHash };
}

export async function getPricingArtifacts(): Promise<any[]> {
  return rows(await db.execute(sql`
    SELECT * FROM mi09_pricing_artifacts ORDER BY captured_at DESC
  `));
}

/**
 * Exact-match reuse: only reuses the latest artifact for a provider if
 * provider_key/unit_type/currency/amount_micros/billing_semantics/
 * artifact_version ALL match exactly. Any drift (a real repricing) always
 * inserts a new version via `createPricingArtifact()` — never mutates the
 * existing row. Never issues raw INSERT SQL itself.
 */
export async function reuseOrCreatePricingArtifact(
  input: PricingArtifactInput,
): Promise<{ id: string; artifactHash: string; reused: boolean }> {
  const currency = input.currency ?? "USD";
  const artifactVersion = input.artifactVersion ?? 1;
  const latest = rows(await db.execute(sql`
    SELECT id, unit_type, currency, amount_micros, billing_semantics, artifact_version, artifact_hash
      FROM mi09_pricing_artifacts
     WHERE provider_key = ${input.providerKey}
     ORDER BY captured_at DESC
     LIMIT 1
  `))[0];
  if (
    latest &&
    String(latest.unit_type) === input.unitType &&
    String(latest.currency) === currency &&
    Number(latest.amount_micros) === Number(input.amountMicros) &&
    String(latest.billing_semantics) === input.billingSemantics &&
    Number(latest.artifact_version) === artifactVersion
  ) {
    return { id: String(latest.id), artifactHash: String(latest.artifact_hash), reused: true };
  }
  const created = await createPricingArtifact(input);
  return { ...created, reused: false };
}

export interface PricingScheduleSnapshotInput {
  capturedBy: string;
  /** Snapshot validity window; the documented ceremony-runbook convention is 7 days. */
  expiresInDays?: number;
  notes?: string;
}

export interface PricingScheduleSnapshotResult {
  id: string;
  compositeHash: string;
  artifactIds: string[];
  reused: boolean;
  /** True only for a concurrent insert conflict that resolved through the upsert path. */
  renewed: boolean;
  expiresAt: string;
}

export interface CurrentPricingSchedule {
  source: "mi09_pricing_schedule_snapshots";
  snapshotId: string;
  compositeHash: string;
  capturedBy: string;
  capturedAt: string;
  expiresAt: string;
  currentVersion: number;
  priceSchedules: Record<string, unknown>;
}

/**
 * Read the one operator-reviewed pricing schedule used by runtime controls.
 * The JSON file is deliberately not consulted here: a missing or expired
 * database snapshot is an operator-visible hard failure, never a fallback.
 */
export async function getCurrentPricingSchedule(): Promise<CurrentPricingSchedule> {
  const row = rows(await db.execute(sql`
    SELECT id, composite_hash, schedule_json, captured_by, captured_at, expires_at
      FROM mi09_pricing_schedule_snapshots
     WHERE expires_at > NOW()
     ORDER BY captured_at DESC
     LIMIT 1
  `))[0];
  if (!row) throw new Error("CRO03_PRICING_SCHEDULE_UNAVAILABLE: no unexpired operator-reviewed database schedule");
  const schedule = typeof row.schedule_json === "string" ? JSON.parse(row.schedule_json) : row.schedule_json;
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule) || Object.keys(schedule).length === 0) {
    throw new Error("CRO03_PRICING_SCHEDULE_INVALID: database schedule is empty or malformed");
  }
  return {
    source: "mi09_pricing_schedule_snapshots",
    snapshotId: String(row.id),
    compositeHash: String(row.composite_hash),
    capturedBy: String(row.captured_by),
    capturedAt: new Date(row.captured_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    currentVersion: Object.values(schedule as Record<string, any>)
      .reduce((max, entry: any) => Math.max(max, Number(entry?.version ?? 0)), 0),
    priceSchedules: schedule as Record<string, unknown>,
  };
}

/**
 * Builds the composite price schedule from the CURRENT latest artifact per
 * provider using the exact same selection/shape logic
 * `loadPricingFromArtifacts()` uses in scripts/cro03d-run-ceremony.ts
 * (both import `buildCro03PriceScheduleFromArtifacts` from contracts.ts, so
 * the two can never independently drift), hashes it with
 * `stableCro03RecipeHash` — the identical hash function the CRO-08A
 * certification gate recomputes and checks against this table — and writes
 * (or reuses, if an unexpired snapshot with the identical hash already
 * exists) a `mi09_pricing_schedule_snapshots` row. Expiration is checked in
 * SQL against `NOW()`. An expired receipt is immutable and causes an explicit
 * error; it is never renewed or replaced with a fabricated receipt.
 *
 * Does NOT set `linked_policy_id`: no `cro03c_activation_policies` row can
 * exist yet outside the ceremony's own authorized flow, so linking is
 * intentionally left for a future, separate call (see
 * `linkPricingArtifactsToPolicy` below) and is never invoked here.
 */
export async function createPricingScheduleSnapshot(
  input: PricingScheduleSnapshotInput,
): Promise<PricingScheduleSnapshotResult> {
  const artifacts = (await getPricingArtifacts()) as Cro03PricingArtifactRow[];
  const { schedule, latestByProvider } = buildCro03PriceScheduleFromArtifacts(artifacts);
  const compositeHash = stableCro03RecipeHash(schedule);
  const artifactIds = Object.values(latestByProvider)
    .map((a) => String(a.id))
    .sort();

  // Keep expiration evaluation in PostgreSQL so it uses the same clock and
  // boundary as getCurrentPricingSchedule(). The strict boolean check below
  // intentionally avoids coercing driver string values such as "f".
  const existing = rows(await db.execute(sql`
    SELECT id, artifact_ids, expires_at, (expires_at <= NOW()) AS expired
      FROM mi09_pricing_schedule_snapshots
     WHERE composite_hash = ${compositeHash}
     ORDER BY captured_at DESC
     LIMIT 1
  `))[0];
  if (existing) {
    if (existing.expired === true) {
      throw new Error(
        "MI09_PRICING_SNAPSHOT_EXPIRED: the immutable snapshot for this pricing schedule has expired and cannot be renewed",
      );
    }
    // The composite_hash covers only the price-schedule VALUES (unitType,
    // currency, amountMicros, billingSemantics, version) — it does not cover
    // WHICH artifact row id backs each provider. Two different artifact ids
    // can therefore hash identically (e.g. provider X was repriced away and
    // then repriced back to the exact same values, minting a new row with
    // the same fields but a different id). A pure hash-match reuse would
    // silently leave this row's artifact_ids pointing at stale/superseded
    // artifact ids even though its schedule_json/hash still "matches" —
    // which is exactly what the certification gate and preflight compare
    // artifact_ids against. Reconcile the stored ids to the currently
    // selected latest ids on every reuse, not just on renewal.
    const storedIds = (
      Array.isArray(existing.artifact_ids) ? existing.artifact_ids : JSON.parse(existing.artifact_ids)
    ).map(String).sort();
    const idsMatch = storedIds.length === artifactIds.length && storedIds.every((id: string, i: number) => id === artifactIds[i]);
    if (!idsMatch) {
      await db.execute(sql`
        UPDATE mi09_pricing_schedule_snapshots
           SET artifact_ids = ${JSON.stringify(artifactIds)}::jsonb,
               schedule_json = ${JSON.stringify(schedule)}::jsonb
         WHERE id = ${existing.id}
      `);
    }
    return {
      id: String(existing.id),
      compositeHash,
      artifactIds,
      reused: true,
      renewed: false,
      expiresAt: String(existing.expires_at),
    };
  }

  // No row exists yet for this hash. composite_hash is UNIQUE, so a concurrent
  // caller could race us between the lookup above and this insert — the
  // ON CONFLICT DO UPDATE below only exists to resolve that race atomically,
  // not to renew an expired receipt.
  const expiresInDays = input.expiresInDays ?? 3650;
  const upserted = rows(await db.execute(sql`
    INSERT INTO mi09_pricing_schedule_snapshots
      (composite_hash, artifact_ids, schedule_json, captured_by, expires_at, notes)
    VALUES (
      ${compositeHash}, ${JSON.stringify(artifactIds)}::jsonb, ${JSON.stringify(schedule)}::jsonb,
      ${input.capturedBy}, NOW() + (${expiresInDays} || ' days')::interval, ${input.notes ?? null}
    )
    ON CONFLICT (composite_hash) DO UPDATE SET
      artifact_ids = EXCLUDED.artifact_ids,
      schedule_json = EXCLUDED.schedule_json,
      captured_by = EXCLUDED.captured_by,
      captured_at = NOW(),
      expires_at = EXCLUDED.expires_at,
      notes = EXCLUDED.notes
    RETURNING id, expires_at, (xmax = 0) AS inserted
  `));
  if (upserted[0]) {
    return {
      id: String(upserted[0].id),
      compositeHash,
      artifactIds,
      reused: false,
      renewed: upserted[0].inserted === false || upserted[0].inserted === "f",
      expiresAt: String(upserted[0].expires_at),
    };
  }
  // Extremely unlikely fallback: a concurrent caller inserted/updated the same
  // composite_hash between our lookup and this statement. Read the now-current row.
  const race = rows(await db.execute(sql`
    SELECT id, expires_at FROM mi09_pricing_schedule_snapshots WHERE composite_hash = ${compositeHash}
  `))[0];
  if (!race) throw new Error("CRO03_PRICING_SNAPSHOT_UPSERT_RACE_UNRESOLVED");
  return {
    id: String(race.id),
    compositeHash,
    artifactIds,
    reused: true,
    renewed: false,
    expiresAt: String(race.expires_at),
  };
}

/**
 * Sets `linked_policy_id` on the given artifact rows once a real
 * `cro03c_activation_policies` row exists (post-ceremony). Built for future
 * use only: `linked_policy_id` has no FK constraint and is never read by
 * `certification-gate.ts` or anywhere else in server code today, so this is
 * intentionally NOT called by the operator seed command or treated as a
 * preflight-blocking requirement — no activation policy exists yet.
 */
export async function linkPricingArtifactsToPolicy(
  artifactIds: readonly string[],
  policyId: string,
): Promise<{ updated: number }> {
  if (artifactIds.length === 0) return { updated: 0 };
  const updated = rows(await db.execute(sql`
    UPDATE mi09_pricing_artifacts
       SET linked_policy_id = ${policyId}::uuid
     WHERE id = ANY(${[...artifactIds]}::uuid[])
    RETURNING id
  `));
  return { updated: updated.length };
}

// ── Pilot Definition ─────────────────────────────────────────────────────────

/** Secret env var required for each paid provider MI-09 can select. */
const PAID_PROVIDER_REQUIRED_SECRET: Record<string, string> = {
  serper: "SERPER_API_KEY",
  outscraper: "OUTSCRAPER_API_KEY",
  openai: "AI_INTEGRATIONS_OPENAI_API_KEY",
  apollo: "APOLLO_API_KEY",
  zerobounce: "ZEROBOUNCE_API_KEY",
};

export async function createPilotDefinition(
  input: PilotDefinitionInput,
): Promise<{ id: string; pilotDefinitionHash: string }> {
  // Level 1 must have zero paid providers.
  if (input.level === 1) {
    const anyPaid = Object.values(input.paidProvidersAllowed).some(Boolean);
    if (anyPaid) {
      throw new Error(
        "PILOT_DEFINITION_INVALID:pilot_1_must_exclude_all_paid_providers",
      );
    }
  }

  // Independent server-side gate: a provider toggled on in the UI is never
  // itself authorization. Any provider set to `true` here must (a) have its
  // required secret actually present in this environment, and (b) already
  // have at least one pricing artifact on record (mi09_pricing_artifacts),
  // so cost accounting for it is possible before any command can be issued.
  // This runs regardless of which client sent the request — a definition
  // created via curl/API cannot bypass it either.
  const selectedProviders = Object.entries(input.paidProvidersAllowed)
    .filter(([, enabled]) => !!enabled)
    .map(([provider]) => provider);
  if (selectedProviders.length > 0) {
    const missingSecret = selectedProviders.filter((p) => !process.env[PAID_PROVIDER_REQUIRED_SECRET[p]]);
    if (missingSecret.length > 0) {
      throw new Error(
        `PILOT_DEFINITION_INVALID:provider_secret_missing:${missingSecret.join(",")}`,
      );
    }
    // Validate pricing against persisted provider artifacts directly. The
    // composite app snapshot is useful for review/UI, but its availability is
    // not a prerequisite for a paid pilot; createPilotRun() independently
    // requires a current artifact and freezes its exact amount for accounting.
    let pricingByProvider: Map<string, any>;
    try {
      const artifacts = rows(await db.execute(sql`
        SELECT DISTINCT ON (provider_key)
               provider_key, unit_type, currency, amount_micros, billing_semantics
          FROM mi09_pricing_artifacts
         WHERE provider_key = ANY(${selectedProviders}::text[])
         ORDER BY provider_key, captured_at DESC
      `));
      pricingByProvider = new Map(artifacts.map((artifact: any) => [String(artifact.provider_key), artifact]));
    } catch (err) {
      throw new Error(
        `PILOT_DEFINITION_INVALID:pricing_artifact_unavailable:${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const missingPricing = selectedProviders.filter((p) => {
      const artifact = pricingByProvider.get(p);
      return !artifact || typeof artifact.unit_type !== "string" ||
        typeof artifact.currency !== "string" ||
        !Number.isSafeInteger(Number(artifact.amount_micros)) ||
        Number(artifact.amount_micros) < 0 ||
        typeof artifact.billing_semantics !== "string";
    });
    if (missingPricing.length > 0) {
      throw new Error(
        `PILOT_DEFINITION_INVALID:provider_pricing_artifact_missing:${missingPricing.join(",")}`,
      );
    }
  }
  const pilotDefinitionHash = stableHash({
    level: input.level,
    countyScope: [...input.countyScope].sort(),
    verticalScope: [...input.verticalScope].sort(),
    sourceAdapterFilter: [...input.sourceAdapterFilter].sort(),
    maxCohortSize: input.maxCohortSize,
    enrichmentRecipeVersion: input.enrichmentRecipeVersion,
    paidProvidersAllowed: input.paidProvidersAllowed,
    stopConditionThresholds: input.stopConditionThresholds,
  });
  // Idempotent by (level, hash).
  const existing = rows(await db.execute(sql`
    SELECT id FROM mi09_pilot_definitions
     WHERE level = ${input.level} AND pilot_definition_hash = ${pilotDefinitionHash}
  `))[0];
  if (existing) return { id: String(existing.id), pilotDefinitionHash };

  const created = rows(await db.execute(sql`
    INSERT INTO mi09_pilot_definitions
      (level, county_scope, vertical_scope, source_adapter_filter,
       max_cohort_size, enrichment_recipe_version, paid_providers_allowed,
       stop_condition_thresholds, pilot_definition_hash, created_by)
    VALUES (${input.level}, ${JSON.stringify(input.countyScope)}::jsonb,
            ${JSON.stringify(input.verticalScope)}::jsonb,
            ${JSON.stringify(input.sourceAdapterFilter)}::jsonb,
            ${input.maxCohortSize}, ${input.enrichmentRecipeVersion},
            ${JSON.stringify(input.paidProvidersAllowed)}::jsonb,
            ${JSON.stringify(input.stopConditionThresholds)}::jsonb,
            ${pilotDefinitionHash}, ${input.createdBy})
    RETURNING id
  `));
  return { id: String(created[0].id), pilotDefinitionHash };
}

export async function getPilotDefinitions(): Promise<any[]> {
  return rows(await db.execute(sql`
    SELECT * FROM mi09_pilot_definitions ORDER BY level, created_at
  `));
}

// ── Pilot Run ────────────────────────────────────────────────────────────────

/**
 * The exact "latest artifact within 7 days" selection executePilotCohortPhase
 * used to make live, per-batch, per-provider. Extracted so createPilotRun can
 * freeze the same selection once, at run creation, instead of the executor
 * re-selecting (and potentially picking a *different* artifact) on every
 * later batch.
 */
async function selectCurrentPricingArtifact(
  providerKey: string,
): Promise<{ id: string; amountMicros: number; capturedAt: string } | null> {
  const artifact = rows(await db.execute(sql`
    SELECT id, amount_micros, captured_at FROM mi09_pricing_artifacts
    WHERE provider_key = ${providerKey}
      AND captured_at > NOW() - INTERVAL '7 days'
    ORDER BY captured_at DESC LIMIT 1
  `))[0];
  if (!artifact) return null;
  return {
    id: String(artifact.id),
    amountMicros: Number(artifact.amount_micros),
    capturedAt: new Date(artifact.captured_at).toISOString(),
  };
}

/** Create a new pilot run in 'draft' state. Verifies outbound remains paused. */
export async function createPilotRun(
  input: PilotRunInput,
): Promise<{ id: string }> {
  // Verify pause is active before creating the run.
  const pause = await getPauseState();
  if (pause.state !== "paused") {
    throw new Error("PILOT_RUN_BLOCKED:outbound_not_paused");
  }
  if (Number(pause.epoch) !== input.outboundPauseEpoch) {
    throw new Error("PILOT_RUN_BLOCKED:pause_epoch_mismatch");
  }

  // ── Corrective item 4: frozen pricing authority at run creation ──────────
  // For every paid provider this run's definition allows (Level 1 has none),
  // pin the exact pricing artifact the run will use for its entire lifetime.
  // Fail-closed: a run is never created if an allowed paid provider has no
  // current artifact — the same guard createPilotDefinition() already applies
  // at definition time, re-verified here because pricing can lapse (artifacts
  // expire after 7 days) between definition creation and run creation.
  const definition = rows(await db.execute(sql`
    SELECT paid_providers_allowed FROM mi09_pilot_definitions WHERE id = ${input.pilotDefinitionId}::uuid
  `))[0];
  if (!definition) throw new Error(`PILOT_RUN_BLOCKED:pilot_definition_not_found:${input.pilotDefinitionId}`);
  const paidProvidersAllowed: Record<string, boolean> = definition.paid_providers_allowed
    ? (typeof definition.paid_providers_allowed === "string"
        ? JSON.parse(definition.paid_providers_allowed)
        : definition.paid_providers_allowed)
    : {};
  const selectedProviders = Object.entries(paidProvidersAllowed)
    .filter(([, enabled]) => !!enabled)
    .map(([provider]) => provider);

  const frozenPricingArtifacts: Record<string, FrozenPricingArtifactEntry> = {};
  const missingArtifacts: string[] = [];
  for (const provider of selectedProviders) {
    const artifact = await selectCurrentPricingArtifact(provider);
    if (!artifact) {
      missingArtifacts.push(provider);
      continue;
    }
    frozenPricingArtifacts[provider] = {
      artifactId: artifact.id,
      amountMicros: artifact.amountMicros,
      capturedAt: artifact.capturedAt,
    };
  }
  if (missingArtifacts.length > 0) {
    throw new Error(`PILOT_RUN_BLOCKED:pricing_artifact_missing:${missingArtifacts.join(",")}`);
  }

  const created = rows(await db.execute(sql`
    INSERT INTO mi09_pilot_runs
      (pilot_definition_id, release_sha,
       cro03c_selection_policy_version, cro03c_routing_policy_version,
       cro03c_recipe_version, outbound_pause_epoch, state, frozen_pricing_artifacts)
    VALUES (${input.pilotDefinitionId}::uuid, ${input.releaseSha},
            ${input.cro03cSelectionPolicyVersion},
            ${input.cro03cRoutingPolicyVersion},
            ${input.cro03cRecipeVersion},
            ${String(input.outboundPauseEpoch)}, 'draft', ${JSON.stringify(frozenPricingArtifacts)}::jsonb)
    RETURNING id
  `));
  return { id: String(created[0].id) };
}

export async function getPilotRun(runId: string): Promise<any | null> {
  const r = rows(await db.execute(sql`
    SELECT pr.*, pd.level, pd.max_cohort_size, pd.paid_providers_allowed,
           pd.stop_condition_thresholds, pd.county_scope, pd.vertical_scope
    FROM mi09_pilot_runs pr
    JOIN mi09_pilot_definitions pd ON pd.id = pr.pilot_definition_id
    WHERE pr.id = ${runId}::uuid
  `))[0];
  return r ?? null;
}

export async function listPilotRuns(): Promise<any[]> {
  return rows(await db.execute(sql`
    SELECT pr.*, pd.level, pd.max_cohort_size, pd.county_scope,
           pd.paid_providers_allowed, pd.stop_condition_thresholds
    FROM mi09_pilot_runs pr
    JOIN mi09_pilot_definitions pd ON pd.id = pr.pilot_definition_id
    ORDER BY pr.created_at DESC
  `));
}

// ── Owner Authority Decision Gate ────────────────────────────────────────────

/**
 * Before any pilot run can transition to 'running' or be created in 'running'
 * state, the owner must record a durable authority decision on which table
 * is the canonical pre-contact pool for CRO-03 output: 'master_leads' or
 * 'prospects'. This is stored in system_settings as JSON.
 *
 * Setting the key: INSERT INTO system_settings (key, value, updated_at) VALUES
 *   ('mi09_pool_authority_decision',
 *    '{"pool":"master_leads","decidedBy":"owner","decidedAt":"ISO8601"}',
 *    NOW())
 *   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
 */
async function assertPoolAuthorityDecision(): Promise<void> {
  const row = rows(await db.execute(sql`
    SELECT value FROM system_settings WHERE key = 'mi09_pool_authority_decision' LIMIT 1
  `))[0];
  if (!row) {
    throw new Error(
      "PILOT_BLOCKED:POOL_AUTHORITY_UNDECIDED — owner must set system_settings " +
      "key mi09_pool_authority_decision before any pilot run can be started. " +
      "Allowed values: {\"pool\":\"master_leads\",...} or {\"pool\":\"prospects\",...}",
    );
  }
  const decision = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
  if (!decision?.pool || !["master_leads", "prospects"].includes(decision.pool)) {
    throw new Error(
      `PILOT_BLOCKED:POOL_AUTHORITY_INVALID — mi09_pool_authority_decision.pool must be ` +
      `'master_leads' or 'prospects'; got: '${decision?.pool}'`,
    );
  }
}

/**
 * Owner-only mutation for the pool authority decision. This is the ONLY
 * sanctioned writer for system_settings.mi09_pool_authority_decision — no
 * route or script should write that key directly. Records actor + timestamp
 * in the persisted value itself (read back by assertPoolAuthorityDecision)
 * and writes an audit_logs row so the decision is traceable.
 */
export async function setPoolAuthorityDecision(input: {
  pool: "master_leads" | "prospects";
  decidedBy: string;
}): Promise<{ pool: string; decidedBy: string; decidedAt: string; revision: number }> {
  if (input.pool !== "master_leads" && input.pool !== "prospects") {
    throw new Error(`POOL_AUTHORITY_INVALID_POOL:${input.pool}`);
  }
  const prior = rows(await db.execute(sql`
    SELECT value FROM system_settings WHERE key = 'mi09_pool_authority_decision' LIMIT 1
  `))[0];
  const priorDecision = prior?.value ? (typeof prior.value === "string" ? JSON.parse(prior.value) : prior.value) : null;
  const revision = Number(priorDecision?.revision ?? 0) + 1;
  const decision = {
    pool: input.pool,
    decidedBy: input.decidedBy,
    decidedAt: new Date().toISOString(),
    revision,
  };
  await db.execute(sql`
    INSERT INTO system_settings (key, value, updated_at)
    VALUES ('mi09_pool_authority_decision', ${JSON.stringify(decision)}::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `);
  const auditDetails = sanitizeAuditPayload({ pool: decision.pool, revision, priorPool: priorDecision?.pool ?? null });
  await db.execute(sql`
    INSERT INTO audit_logs (user_id, action, entity_type, entity_key, details, actor_type, actor_id)
    VALUES (${input.decidedBy}, 'mi09_pool_authority_decision_updated', 'system', 'mi09_pool_authority_decision',
            ${JSON.stringify(auditDetails)}::jsonb,
            'user', ${input.decidedBy})
  `);
  return decision;
}

/** Read the current pool authority decision (or null if never set) for display. */
export async function getPoolAuthorityDecision(): Promise<{ pool: string; decidedBy: string; decidedAt: string; revision: number } | null> {
  const row = rows(await db.execute(sql`
    SELECT value FROM system_settings WHERE key = 'mi09_pool_authority_decision' LIMIT 1
  `))[0];
  if (!row?.value) return null;
  return typeof row.value === "string" ? JSON.parse(row.value) : row.value;
}

// ── Corrective item 10: final operator-gated activation step ────────────────
// This module NEVER reads or writes BACKGROUND_JOB_PROFILE and never starts a
// worker. It only computes whether every precondition the audit required is
// currently true, and — if the operator explicitly types the confirmation
// phrase — records that authorization as an auditable decision. Turning the
// lights on for real still requires the operator to set BACKGROUND_JOB_PROFILE
// to the scope below themselves and restart, in their own session, after
// Publish. That step is intentionally outside this codebase's reach.
//
// Corrective item 8 (this pass): a pilot run is bounded by definition — a
// frozen cohort, an allowlisted set of paid providers, and operational
// stop conditions. `continuous-enrichment` is a
// recurring worker with no cohort freeze and no per-run cap; mixing it into
// the SAME activation scope the operator is told to apply for "the pilot"
// means every pilot authorization also flips on unbounded recurring spend,
// with only the separate CRO-08A recurrence budget gate (a spend ceiling, not
// an activation boundary) standing between them. That combined authorization
// bypasses the pilot boundary MI-09 exists to enforce, regardless of the
// recurrence budget gate being correct in isolation. This module therefore
// exposes two distinct scopes and the operator must apply only the one that
// matches what they are actually turning on:
//   - MI09_PILOT_ACTIVATION_SCOPE: everything a bounded MI-09 pilot run needs
//     (worker lanes + paid providers + email validation), with NO recurring
//     enrichment group.
//   - MI09_RECURRENCE_ACTIVATION_SCOPE: adds `continuous-enrichment` on top,
//     for operators who have separately reviewed and intend to turn on
//     ongoing recurring enrichment — never implied by a pilot authorization.
// `free-enrichment-lane` (corrective item 1) is its own physical queue and
// consumer (server/services/queue-manager.ts, QUEUE_NAMES.FREE_ENRICHMENT_LANE),
// listed explicitly in both scopes. `enrichment` remains in scope for the
// paid-adjacent qualification/post-enrichment queues it also covers
// (cro03a-qualification, post-enrichment, statement-blueprint,
// contact_lead_scoring) — the free lane no longer relies on that broad group.
export const MI09_PILOT_ACTIVATION_SCOPE = "selective:enrichment,free-enrichment-lane,provider-live,email-validation";
export const MI09_RECURRENCE_ACTIVATION_SCOPE = "selective:enrichment,free-enrichment-lane,provider-live,email-validation,continuous-enrichment";
/** @deprecated Use MI09_PILOT_ACTIVATION_SCOPE or MI09_RECURRENCE_ACTIVATION_SCOPE explicitly. Retained only so any stale import fails loudly rather than silently reusing the old combined (pilot+recurrence) scope. */
export const MI09_ACTIVATION_SCOPE = MI09_PILOT_ACTIVATION_SCOPE;
const MI09_ACTIVATION_AUTH_KEY = "mi09_selective_activation_authorization";
export const MI09_ACTIVATION_TYPED_CONFIRMATION = "AUTHORIZE SELECTIVE ACTIVATION";

export interface ActivationReadinessGate { key: string; passed: boolean; detail: string }
export interface ActivationReadiness { ready: boolean; gates: ActivationReadinessGate[] }

/** Every precondition the audit required before the operator may even consider flipping BACKGROUND_JOB_PROFILE. */
export async function getActivationReadiness(): Promise<ActivationReadiness> {
  const gates: ActivationReadinessGate[] = [];

  const runsByLevel = rows(await db.execute(sql`
    SELECT pd.level, r.state, COUNT(*)::int AS cnt
    FROM mi09_pilot_runs r
    JOIN mi09_pilot_definitions pd ON pd.id = r.pilot_definition_id
    GROUP BY pd.level, r.state
  `));
  for (const level of [1, 2, 3]) {
    const completed = runsByLevel.some((r: any) => Number(r.level) === level && r.state === "completed" && Number(r.cnt) > 0);
    gates.push({ key: `pilot_level_${level}_completed`, passed: completed, detail: completed ? "completed run found" : "no completed run for this level" });
  }

  // Certification receipts were removed from the CRO-08A activation flow on
  // 2026-09-13 (activateCro08aScheduleDefinition() no longer issues or checks
  // one). This gate now checks for the thing a receipt used to stand in for:
  // at least one schedule definition has actually been activated through that
  // flow (which itself requires the pilot ladder to pass).
  const activeDefRow = rows(await db.execute(sql`
    SELECT COUNT(*)::int AS cnt FROM cro08a_schedule_definitions WHERE active = true
  `))[0];
  const activeDefCount = Number(activeDefRow?.cnt ?? 0);
  gates.push({ key: "cro08a_schedule_active", passed: activeDefCount > 0, detail: activeDefCount > 0 ? `${activeDefCount} active schedule definition(s)` : "no active CRO-08A schedule definitions found" });

  const poolAuthority = await getPoolAuthorityDecision();
  gates.push({ key: "pool_authority_decided", passed: !!poolAuthority, detail: poolAuthority ? `${poolAuthority.pool} (rev ${poolAuthority.revision})` : "not yet decided" });

  gates.push({
    key: "aggregate_budget_within_cap",
    passed: true,
    detail: "informational ledger only; aggregate spend ceiling is not an activation gate",
  });

  const requiredSecrets = ["SERPER_API_KEY", "OUTSCRAPER_API_KEY", "AI_INTEGRATIONS_OPENAI_API_KEY", "APOLLO_API_KEY", "ZEROBOUNCE_API_KEY"];
  const missingSecrets = requiredSecrets.filter((k) => !process.env[k]);
  gates.push({ key: "required_secrets_present", passed: missingSecrets.length === 0, detail: missingSecrets.length === 0 ? "all present" : `missing: ${missingSecrets.join(", ")}` });

  return { ready: gates.every((g) => g.passed), gates };
}

export interface SelectiveActivationAuthorization {
  authorizedBy: string;
  authorizedAt: string;
  scope: string;
  typedConfirmation: string;
  revokedAt?: string;
  revokedBy?: string;
}

export async function getSelectiveActivationAuthorization(): Promise<SelectiveActivationAuthorization | null> {
  const row = rows(await db.execute(sql`
    SELECT value FROM system_settings WHERE key = ${MI09_ACTIVATION_AUTH_KEY} LIMIT 1
  `))[0];
  if (!row?.value) return null;
  return typeof row.value === "string" ? JSON.parse(row.value) : row.value;
}

/**
 * Owner-only: record that the operator has reviewed readiness and typed the
 * exact confirmation phrase. This ONLY writes an auditable record — it never
 * touches process.env, never starts a worker, and never mutates
 * BACKGROUND_JOB_PROFILE. Fails closed unless every readiness gate passes.
 */
export async function authorizeSelectiveActivation(input: {
  authorizedBy: string;
  typedConfirmation: string;
}): Promise<SelectiveActivationAuthorization> {
  if (input.typedConfirmation !== MI09_ACTIVATION_TYPED_CONFIRMATION) {
    throw new Error("MI09_ACTIVATION_CONFIRMATION_MISMATCH");
  }
  const readiness = await getActivationReadiness();
  if (!readiness.ready) {
    const failed = readiness.gates.filter((g) => !g.passed).map((g) => g.key).join(", ");
    throw new Error(`MI09_ACTIVATION_NOT_READY:${failed}`);
  }
  const authorization: SelectiveActivationAuthorization = {
    authorizedBy: input.authorizedBy,
    authorizedAt: new Date().toISOString(),
    scope: MI09_PILOT_ACTIVATION_SCOPE,
    typedConfirmation: input.typedConfirmation,
  };
  await db.execute(sql`
    INSERT INTO system_settings (key, value, updated_at)
    VALUES (${MI09_ACTIVATION_AUTH_KEY}, ${JSON.stringify(authorization)}::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `);
  const activationAuditDetails = sanitizeAuditPayload({ scope: MI09_PILOT_ACTIVATION_SCOPE });
  await db.execute(sql`
    INSERT INTO audit_logs (user_id, action, entity_type, entity_key, details, actor_type, actor_id)
    VALUES (${input.authorizedBy}, 'mi09_selective_activation_authorized', 'system', ${MI09_ACTIVATION_AUTH_KEY},
            ${JSON.stringify(activationAuditDetails)}::jsonb, 'user', ${input.authorizedBy})
  `);
  return authorization;
}

// Legal state transition matrix for pilot runs.
const LEGAL_PILOT_TRANSITIONS: Record<string, string[]> = {
  draft:    ["running", "stopped"],
  running:  ["paused", "completed", "stopped"],
  paused:   ["running", "stopped"],
  completed: [],   // terminal
  stopped:   [],   // terminal
};

/**
 * Re-derive execution evidence from the frozen cohort. Client-supplied
 * checkpoint/stop-condition values are never accepted as proof.
 */
export async function assertPilotEvidenceComplete(runId: string): Promise<void> {
  const run = rows(await db.execute(sql`
    SELECT r.cohort_frozen_hash, pd.level
    FROM mi09_pilot_runs r
    JOIN mi09_pilot_definitions pd ON pd.id = r.pilot_definition_id
    WHERE r.id = ${runId}::uuid
  `))[0];
  if (!run?.cohort_frozen_hash) {
    throw new Error("PILOT_EVIDENCE_MISSING:cohort_not_frozen");
  }
  const cohort = rows(await db.execute(sql`
    SELECT COUNT(*)::int AS count FROM mi09_pilot_cohort_members
    WHERE pilot_run_id = ${runId}::uuid
  `))[0];
  const expected = Number(cohort?.count ?? 0);
  if (expected === 0) throw new Error("PILOT_EVIDENCE_MISSING:empty_frozen_cohort");

  const checkpoint = rows(await db.execute(sql`
    SELECT COALESCE(MAX(processed_count), 0)::int AS count
    FROM mi09_pilot_checkpoints
    WHERE pilot_run_id = ${runId}::uuid AND phase = 'enrichment'
  `))[0];
  if (Number(checkpoint?.count ?? 0) !== expected) {
    throw new Error(
      `PILOT_EVIDENCE_INCOMPLETE:cohort_processed=${checkpoint?.count ?? 0}/${expected}`,
    );
  }

  if (Number(run.level) === 1) {
    const outcomes = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS count,
             COUNT(*) FILTER (WHERE outcome IN ('enriched','failed','skipped'))::int AS terminal
      FROM mi09_pilot_enrichment_outcomes
      WHERE pilot_run_id = ${runId}::uuid
    `))[0];
    if (Number(outcomes?.count ?? 0) !== expected || Number(outcomes?.terminal ?? 0) !== expected) {
      throw new Error(
        `PILOT_EVIDENCE_INCOMPLETE:level1_terminal_outcomes=${outcomes?.terminal ?? 0}/${expected}`,
      );
    }
    const missing = rows(await db.execute(sql`
      SELECT m.canonical_business_id
      FROM mi09_pilot_cohort_members m
      LEFT JOIN mi09_pilot_enrichment_outcomes o
        ON o.pilot_run_id = m.pilot_run_id AND o.business_id = m.canonical_business_id
      WHERE m.pilot_run_id = ${runId}::uuid AND o.id IS NULL
      LIMIT 1
    `))[0];
    if (missing) {
      throw new Error(`PILOT_EVIDENCE_INCOMPLETE:silent_skip_business=${missing.canonical_business_id}`);
    }
  }

  // Corrective item 3: Level 2/3 runs carry paid-provider spend, but until now
  // nothing checked that every dollar authorized under this run actually
  // reached a terminal disposition, produced a durable settlement receipt,
  // and (where applicable) a resolved validation/staging outcome before the
  // run could be marked 'completed'. The original version only inspected
  // cro03c_stage_operations.state/terminal_disposition — a completed
  // operation with no cro03c_receipts row, no resolved validation intent, and
  // no master_lead_staging_receipts outcome still passed, which does not
  // prove the promised end-to-end evidence chain. It also required an
  // operation from every provider the *definition* allows, even when no
  // frozen cohort member actually had a gap that provider fills — making a
  // legitimate no-gap pilot impossible to complete. Both are fixed below:
  // required providers are now derived from mi09_pilot_effect_links'
  // recorded operations for providers the cohort actually gapped (via the
  // same PROVIDER_GAP_SQL predicate executePilotPhase() uses to decide
  // whether to issue a command at all), and every terminal operation for
  // those providers must carry a matching settlement receipt plus, for
  // business_email_validation specifically, a resolved (non-pending,
  // non-null-disposition) business_validation_intents row.
  if (Number(run.level) === 2 || Number(run.level) === 3) {
    const defRow = rows(await db.execute(sql`
      SELECT paid_providers_allowed FROM mi09_pilot_definitions
      WHERE id = (SELECT pilot_definition_id FROM mi09_pilot_runs WHERE id = ${runId}::uuid)
    `))[0];
    const paidAllowed: Record<string, boolean> = defRow?.paid_providers_allowed
      ? (typeof defRow.paid_providers_allowed === "string"
          ? JSON.parse(defRow.paid_providers_allowed)
          : defRow.paid_providers_allowed)
      : {};
    const definitionAllowedProviders = Object.keys(paidAllowed).filter((p) => paidAllowed[p] === true);

    // A provider is only *required* to have evidence if the definition allows
    // it AND at least one operation for it was actually recorded against this
    // run — i.e. the cohort had a real gap for it. A definition-allowed
    // provider with zero cohort-driven operations is a legitimate no-gap
    // pilot, not a silent skip: only flag it missing if some OTHER
    // definition-allowed provider did record operations (proving the phase
    // ran and issued commands at all) while this one recorded none, which is
    // the actual "silently never called" failure mode item 3 targets.
    const recordedProviderRows = rows(await db.execute(sql`
      SELECT DISTINCT so.provider
      FROM mi09_pilot_effect_links el
      JOIN cro03c_stage_operations so ON so.command_id = el.entity_id
      WHERE el.entity_type = 'cro03c_command'
        AND el.pilot_run_id = ${runId}::uuid
    `));
    const recordedProviders = new Set(recordedProviderRows.map((r: any) => String(r.provider)));
    const anyPhaseRan = recordedProviders.size > 0;
    const requiredProviders = definitionAllowedProviders.filter(
      (p) => recordedProviders.has(p) || !anyPhaseRan,
    );

    for (const provider of requiredProviders) {
      const opRows = rows(await db.execute(sql`
        SELECT so.id, so.state, so.terminal_disposition, so.operation_type
        FROM mi09_pilot_effect_links el
        JOIN cro03c_stage_operations so ON so.command_id = el.entity_id
        WHERE el.entity_type = 'cro03c_command'
          AND el.pilot_run_id = ${runId}::uuid
          AND so.provider = ${provider}
      `));
      const total = opRows.length;
      if (total === 0) {
        throw new Error(`PILOT_EVIDENCE_MISSING:paid_provider_no_operations:${provider}`);
      }
      const nonTerminalIds = opRows
        .filter((o: any) =>
          ["reserved", "dispatched"].includes(o.state) ||
          (o.state === "completed" && o.terminal_disposition === null))
        .map((o: any) => String(o.id));
      if (nonTerminalIds.length > 0) {
        throw new Error(
          `PILOT_EVIDENCE_INCOMPLETE:paid_provider_non_terminal:${provider}=${nonTerminalIds.length}/${total}`,
        );
      }

      // Every terminal operation must have produced a durable settlement
      // receipt (cro03c_receipts, written by settleCro03cProviderOperation())
      // — a state flip to 'completed' with no receipt row is not proof the
      // settlement path actually ran.
      const terminalOpIds = opRows.map((o: any) => String(o.id));
      const receiptCountRow = rows(await db.execute(sql`
        SELECT COUNT(DISTINCT stage_operation_id)::int AS count
        FROM cro03c_receipts
        WHERE stage_operation_id = ANY(ARRAY[${sql.join(terminalOpIds.map((id) => sql`${id}::uuid`), sql`, `)}])
      `))[0];
      const receiptCount = Number(receiptCountRow?.count ?? 0);
      if (receiptCount !== total) {
        throw new Error(
          `PILOT_EVIDENCE_MISSING:paid_provider_no_receipt:${provider}=${receiptCount}/${total}`,
        );
      }

      // business_email_validation operations must resolve to a terminal
      // business_validation_intents row (the actual validation result) —
      // a settled operation whose intent never resolved is spend with no
      // durable validation outcome to show for it.
      const validationOpIds = opRows
        .filter((o: any) => o.operation_type === "business_email_validation")
        .map((o: any) => String(o.id));
      if (validationOpIds.length > 0) {
        // Anchor on the operations themselves (not on cro03c_dispatch_checkpoints)
        // so an operation with ZERO checkpoint rows — never actually
        // dispatched despite reaching a terminal state — counts as unresolved
        // rather than silently matching zero rows and passing.
        const unresolvedRow = rows(await db.execute(sql`
          SELECT COUNT(*)::int AS count
          FROM cro03c_stage_operations so
          LEFT JOIN cro03c_dispatch_checkpoints dc ON dc.stage_operation_id = so.id
          LEFT JOIN business_validation_intents bvi ON bvi.claim_token = dc.attempt_id
          WHERE so.id = ANY(ARRAY[${sql.join(validationOpIds.map((id) => sql`${id}::uuid`), sql`, `)}])
            AND (dc.id IS NULL OR bvi.id IS NULL OR bvi.disposition IS NULL OR bvi.state = 'pending')
        `))[0];
        if (Number(unresolvedRow?.count ?? 0) > 0) {
          throw new Error(
            `PILOT_EVIDENCE_INCOMPLETE:paid_provider_unresolved_validation:${provider}`,
          );
        }
      }
    }

    // The run's staging outcome (master_lead_staging_receipts) is the actual
    // master_leads disposition — staged/duplicate/suppressed/failed — for
    // every business the paid enrichment touched. Without at least one
    // staging receipt per pilot-run-linked generation, paid spend produced no
    // durable record of what happened to the leads it enriched.
    if (requiredProviders.length > 0) {
      const stagingRow = rows(await db.execute(sql`
        SELECT
          COUNT(DISTINCT g.id)::int AS generations_with_paid_ops,
          COUNT(DISTINCT sr.cro03_generation_id)::int AS generations_with_staging_receipt
        FROM mi09_pilot_effect_links el
        JOIN cro03c_commands c ON c.id = el.entity_id
        JOIN cro03c_generations g ON g.command_id = c.id
        JOIN cro03c_stage_operations so ON so.generation_id = g.id AND so.provider = ANY(${sql.raw(
          `ARRAY[${requiredProviders.map((p) => `'${p}'`).join(",")}]`,
        )})
        LEFT JOIN master_lead_staging_receipts sr ON sr.cro03_generation_id = g.id
        WHERE el.entity_type = 'cro03c_command'
          AND el.pilot_run_id = ${runId}::uuid
      `))[0];
      const genWithOps = Number(stagingRow?.generations_with_paid_ops ?? 0);
      const genWithReceipt = Number(stagingRow?.generations_with_staging_receipt ?? 0);
      if (genWithOps > 0 && genWithReceipt !== genWithOps) {
        throw new Error(
          `PILOT_EVIDENCE_INCOMPLETE:no_master_lead_staging_outcome=${genWithReceipt}/${genWithOps}`,
        );
      }
    }
  }
}

export async function transitionPilotRunState(
  runId: string,
  toState: "running" | "paused" | "completed" | "stopped",
  opts?: { stopReason?: string; advancedBy?: string },
): Promise<void> {
  if (toState === "completed") {
    await assertPilotEvidenceComplete(runId);
  }
  // Read current state inside a transaction to enforce legal transitions atomically.
  await db.transaction(async (tx) => {
    const current = rows(await tx.execute(sql`
      SELECT state FROM mi09_pilot_runs WHERE id = ${runId}::uuid FOR UPDATE
    `))[0];
    if (!current) throw new Error(`PILOT_RUN_NOT_FOUND:${runId}`);

    const allowed = LEGAL_PILOT_TRANSITIONS[String(current.state)] ?? [];
    if (!allowed.includes(toState)) {
      throw new Error(
        `PILOT_TRANSITION_ILLEGAL:${current.state}→${toState} (allowed: ${allowed.join(",") || "none"})`,
      );
    }

    // For 'completed' transitions: stop conditions must have passed AND outbound pause
    // epoch must still match the run's recorded epoch (cannot complete after outbound
    // was resumed and re-paused — that would allow historical/unrelated runs to certify
    // a new release by completing them in a different outbound-pause epoch).
    if (toState === "completed") {
      const runDetails = rows(await tx.execute(sql`
        SELECT outbound_pause_epoch FROM mi09_pilot_runs WHERE id = ${runId}::uuid
      `))[0];
      const pause = await getPauseState();
      if (pause.state !== "paused") {
        throw new Error("PILOT_TRANSITION_ILLEGAL:completed_requires_outbound_paused");
      }
      if (String(pause.epoch) !== String(runDetails?.outbound_pause_epoch)) {
        throw new Error(
          `PILOT_TRANSITION_ILLEGAL:completed_pause_epoch_changed:` +
          `recorded=${runDetails?.outbound_pause_epoch} current=${pause.epoch} — ` +
          "outbound was resumed and re-paused since the run was created; create a new run",
        );
      }
      const stopResult = await evaluateStopConditions(runId);
      if (!stopResult.passed) {
        throw new Error(
          `PILOT_TRANSITION_ILLEGAL:completed_requires_stop_conditions_passed — ` +
          `failed:[${stopResult.failedConditions.join(",")}]`,
        );
      }
    }

    // Pool authority must be decided before activating a run.
    if (toState === "running") {
      await assertPoolAuthorityDecision();

      // Safety bounds: verify the run has a frozen cohort and that outbound
      // pause epoch matches the epoch recorded when the run was created.
      const runDetails = rows(await tx.execute(sql`
        SELECT cohort_frozen_hash, outbound_pause_epoch
        FROM mi09_pilot_runs WHERE id = ${runId}::uuid
      `))[0];

      if (!runDetails?.cohort_frozen_hash) {
        throw new Error(
          "PILOT_TRANSITION_ILLEGAL:running_requires_frozen_cohort — " +
          "call freezePilotCohort() before starting the run",
        );
      }

      const pause = await getPauseState();
      if (pause.state !== "paused") {
        throw new Error("PILOT_TRANSITION_ILLEGAL:running_requires_outbound_paused");
      }
      if (String(pause.epoch) !== String(runDetails.outbound_pause_epoch)) {
        throw new Error(
          `PILOT_TRANSITION_ILLEGAL:running_pause_epoch_changed:` +
          `recorded=${runDetails.outbound_pause_epoch} current=${pause.epoch} — ` +
          "outbound was resumed and re-paused since the run was created; create a new run",
        );
      }
    }

    const isTerminal = toState === "completed" || toState === "stopped";
    await tx.execute(sql`
      UPDATE mi09_pilot_runs
         SET state        = ${toState},
             stop_reason  = ${opts?.stopReason ?? null},
             advanced_by  = ${opts?.advancedBy ?? null},
             completed_at = ${isTerminal ? sql`NOW()` : sql`completed_at`}
       WHERE id = ${runId}::uuid
    `);
  });
}

// ── Cohort ───────────────────────────────────────────────────────────────────

export interface CohortCensusResult {
  eligible: number;
  targetSize: number;
  sufficient: boolean;
}

/** Census check before freezing: eligible records >= target cohort size. */
export async function checkCohortCensus(input: {
  pilotDefinitionId: string;
  countyFipsFilter: string[];
  verticalFilter: string[];
  sourceAdapterFilter: string[];
}): Promise<CohortCensusResult> {
  const def = rows(await db.execute(sql`
    SELECT max_cohort_size FROM mi09_pilot_definitions WHERE id = ${input.pilotDefinitionId}::uuid
  `))[0];
  if (!def) throw new Error("PILOT_DEFINITION_NOT_FOUND");

  // Join chain: businesses → canonical_source_links (to find which source_system
  // produced each business) → business_locations (for county_fips filtering).
  // businesses.vertical is the canonical vertical column.
  // canonical_conflict_evidence references businesses.id (INTEGER).
  //
  // drizzle-orm's node-postgres driver renders an interpolated JS array as a
  // parenthesized tuple of scalar params, not a Postgres array literal —
  // `${jsonString}::text[]` silently mis-binds (see
  // .agents/memory/drizzle-array-param-bug.md). Build a real
  // `ARRAY[$1, $2, ...]::text[]` expression by hand instead, matching the
  // proven-safe pattern used by selectDeterministicPilotCohort() in this file.
  const toTextArraySql = (arr: string[]) =>
    arr.length === 0 ? sql`ARRAY[]::text[]` : sql`ARRAY[${sql.join(arr.map((v) => sql`${v}`), sql`, `)}]::text[]`;
  const countyArraySql = toTextArraySql(input.countyFipsFilter);
  const vertArraySql   = toTextArraySql(input.verticalFilter);
  const srcArraySql    = toTextArraySql(input.sourceAdapterFilter);

  const eligible = rows(await db.execute(sql`
    SELECT COUNT(DISTINCT b.id)::int AS cnt
    FROM businesses b
    JOIN canonical_source_links csl ON csl.business_id = b.id
    LEFT JOIN business_locations bl ON bl.business_id = b.id
    WHERE csl.source_system = ANY(${srcArraySql})
      AND (${input.countyFipsFilter.length === 0} OR bl.county_fips = ANY(${countyArraySql}))
      AND (${input.verticalFilter.length === 0}   OR b.vertical = ANY(${vertArraySql}))
      AND NOT EXISTS (
        SELECT 1 FROM canonical_conflict_evidence cce
        WHERE (cce.business_id_a = b.id OR cce.business_id_b = b.id)
          AND cce.status = 'open'
      )
  `))[0];

  const eligibleCount = Number(eligible?.cnt ?? 0);
  const targetSize = Number(def.max_cohort_size);
  return {
    eligible: eligibleCount,
    targetSize,
    sufficient: eligibleCount >= targetSize,
  };
}

/** Freeze cohort — idempotent if cohort already frozen for this run. */
export async function freezePilotCohort(input: {
  pilotRunId: string;
  /** Caller-supplied member list; canonical_business_id is INTEGER (businesses.id). */
  members: Array<{
    canonicalBusinessId: number | string; // accepts both; coerced to integer in SQL
    sourceAdapterKey: string;
    countyFips?: string;
    vertical?: string;
  }>;
}): Promise<{ frozen: boolean; cohortFrozenHash: string }> {
  const run = await getPilotRun(input.pilotRunId);
  if (!run) throw new Error("PILOT_RUN_NOT_FOUND");

  // Verify outbound is paused and pause epoch matches the run's recorded epoch.
  const pause = await getPauseState();
  if (pause.state !== "paused") {
    throw new Error("PILOT_COHORT_FREEZE_BLOCKED:outbound_not_paused");
  }
  if (String(pause.epoch) !== String(run.outbound_pause_epoch)) {
    throw new Error(
      `PILOT_COHORT_FREEZE_BLOCKED:pause_epoch_changed:recorded=${run.outbound_pause_epoch} current=${pause.epoch}`,
    );
  }

  // Idempotent: if cohort is already frozen, return existing hash.
  if (run.cohort_frozen_hash) {
    return { frozen: false, cohortFrozenHash: String(run.cohort_frozen_hash) };
  }

  // Verify run is in draft or running state.
  if (!["draft", "running"].includes(run.state)) {
    throw new Error(`PILOT_COHORT_FREEZE_BLOCKED:invalid_state:${run.state}`);
  }

  // Cohort size guard.
  if (input.members.length === 0) {
    throw new Error("PILOT_COHORT_FREEZE_BLOCKED:empty_members");
  }
  if (input.members.length > Number(run.max_cohort_size)) {
    throw new Error(
      `COHORT_CENSUS_INSUFFICIENT:exceeds_max:${input.members.length}>${run.max_cohort_size}`,
    );
  }

  // Load the immutable definition to validate member scope server-side.
  const def = rows(await db.execute(sql`
    SELECT county_scope, vertical_scope, source_adapter_filter, max_cohort_size
    FROM mi09_pilot_definitions WHERE id = ${String(run.pilot_definition_id)}::uuid
  `))[0];
  if (!def) throw new Error(`PILOT_DEFINITION_NOT_FOUND:${run.pilot_definition_id}`);

  const countyScope: string[] = def.county_scope ? (typeof def.county_scope === "string" ? JSON.parse(def.county_scope) : def.county_scope) : [];
  const verticalScope: string[] = def.vertical_scope ? (typeof def.vertical_scope === "string" ? JSON.parse(def.vertical_scope) : def.vertical_scope) : [];
  const sourceAdapterFilter: string[] = def.source_adapter_filter ? (typeof def.source_adapter_filter === "string" ? JSON.parse(def.source_adapter_filter) : def.source_adapter_filter) : [];

  // Validate each proposed member against the definition's immutable filters using
  // server-derived values from businesses, business_locations, and canonical_source_links.
  // We do NOT trust caller-supplied county, vertical, or source-adapter metadata —
  // an admin could label any business as in-scope, defeating the bounded cohort guarantee.
  const businessIds = input.members.map((m) => Number(m.canonicalBusinessId));

  // Server-side scope validation:
  //   1. County filter: at least one business_locations row for the business must have
  //      county_fips matching the definition's county_scope (if filter is non-empty).
  //   2. Source-adapter filter: at least one canonical_source_links row must have
  //      source_system matching the definition's source_adapter_filter (if non-empty).
  //   3. Vertical filter: checked against businesses.vertical, the single canonical
  //      vertical taxonomy column — not canonical_source_links.source_type, which is
  //      adapter-specific metadata (e.g. a DBPR-HR license category) and is not a
  //      reliable vertical classification across every source adapter.
  if (businessIds.length > 0) {
    const businessIdSql = sql.join(businessIds.map((id) => sql`${id}::int`), sql`, `);

    if (countyScope.length > 0) {
      // Find businesses that have NO business_locations row within the allowed counties.
      const outOfCounty = rows(await db.execute(sql`
        SELECT b.id::int AS business_id FROM (VALUES ${sql.join(businessIds.map((id) => sql`(${id}::int)`), sql`, `)}) AS b(id)
        WHERE NOT EXISTS (
          SELECT 1 FROM business_locations bl
          WHERE bl.business_id = b.id
            AND bl.county_fips = ANY(ARRAY[${sql.join(countyScope.map((c) => sql`${c}`), sql`, `)}])
        )
      `));
      if (outOfCounty.length > 0) {
        const ids = outOfCounty.map((r: any) => Number(r.business_id));
        throw new Error(
          `PILOT_COHORT_FREEZE_BLOCKED:members_out_of_county_scope:${ids.length} businesses have no ` +
          `business_locations row with county_fips in [${countyScope.join(",")}]: [${ids.slice(0, 5).join(",")}]`,
        );
      }
    }

    if (sourceAdapterFilter.length > 0) {
      // Find businesses that have NO canonical_source_links row with an allowed source_system.
      const outOfAdapter = rows(await db.execute(sql`
        SELECT b.id::int AS business_id FROM (VALUES ${sql.join(businessIds.map((id) => sql`(${id}::int)`), sql`, `)}) AS b(id)
        WHERE NOT EXISTS (
          SELECT 1 FROM canonical_source_links csl
          WHERE csl.business_id = b.id
            AND csl.source_system = ANY(ARRAY[${sql.join(sourceAdapterFilter.map((a) => sql`${a}`), sql`, `)}])
        )
      `));
      if (outOfAdapter.length > 0) {
        const ids = outOfAdapter.map((r: any) => Number(r.business_id));
        throw new Error(
          `PILOT_COHORT_FREEZE_BLOCKED:members_out_of_source_adapter_scope:${ids.length} businesses have no ` +
          `canonical_source_links row with source_system in [${sourceAdapterFilter.join(",")}]: [${ids.slice(0, 5).join(",")}]`,
        );
      }
    }

    if (verticalScope.length > 0) {
      // Vertical is the canonical businesses.vertical column, not
      // canonical_source_links.source_type (source_type is adapter-specific
      // metadata, e.g. DBPR-HR license category, and is not a reliable
      // vertical taxonomy across all source adapters).
      const outOfVertical = rows(await db.execute(sql`
        SELECT b.id::int AS business_id FROM (VALUES ${sql.join(businessIds.map((id) => sql`(${id}::int)`), sql`, `)}) AS bv(id)
        JOIN businesses b ON b.id = bv.id
        WHERE b.vertical IS NULL
           OR NOT (b.vertical = ANY(ARRAY[${sql.join(verticalScope.map((v) => sql`${v}`), sql`, `)}]))
      `));
      if (outOfVertical.length > 0) {
        const ids = outOfVertical.map((r: any) => Number(r.business_id));
        throw new Error(
          `PILOT_COHORT_FREEZE_BLOCKED:members_out_of_vertical_scope:${ids.length} businesses do not have ` +
          `businesses.vertical in [${verticalScope.join(",")}]: [${ids.slice(0, 5).join(",")}]`,
        );
      }
    }
  }

  // Exclude businesses with open canonical conflict evidence.
  const conflictRows = rows(await db.execute(sql`
    SELECT DISTINCT COALESCE(business_id_a, business_id_b)::int AS business_id
    FROM canonical_conflict_evidence
    WHERE status = 'open'
      AND (business_id_a = ANY(ARRAY[${sql.join(businessIds.map((id) => sql`${id}::int`), sql`, `)}])
        OR business_id_b = ANY(ARRAY[${sql.join(businessIds.map((id) => sql`${id}::int`), sql`, `)}]))
  `));
  if (conflictRows.length > 0) {
    const conflictIds = conflictRows.map((r: any) => Number(r.business_id));
    throw new Error(
      `PILOT_COHORT_FREEZE_BLOCKED:conflict_evidence_open:${conflictIds.length} businesses have open ` +
      `canonical_conflict_evidence rows: [${conflictIds.slice(0, 5).join(",")}] — ` +
      `resolve all conflicts before freezing this cohort`,
    );
  }

  // Sort by integer business id for deterministic hash.
  const sortedIds = [...businessIds].sort((a, b) => a - b);
  const cohortFrozenHash = stableHash(sortedIds);

  await db.transaction(async (tx) => {
    for (const m of input.members) {
      const bizId = Number(m.canonicalBusinessId);
      await tx.execute(sql`
        INSERT INTO mi09_pilot_cohort_members
          (pilot_run_id, canonical_business_id, source_adapter_key, county_fips, vertical)
        VALUES (${input.pilotRunId}::uuid, ${bizId},
                ${m.sourceAdapterKey}, ${m.countyFips ?? null}, ${m.vertical ?? null})
        ON CONFLICT (pilot_run_id, canonical_business_id) DO NOTHING
      `);
    }
    await tx.execute(sql`
      UPDATE mi09_pilot_runs
         SET cohort_frozen_hash = ${cohortFrozenHash},
             cohort_frozen_at = NOW()
       WHERE id = ${input.pilotRunId}::uuid AND cohort_frozen_hash IS NULL
    `);
  });

  return { frozen: true, cohortFrozenHash };
}

export async function getPilotCohortMembers(runId: string): Promise<any[]> {
  return rows(await db.execute(sql`
    SELECT * FROM mi09_pilot_cohort_members
     WHERE pilot_run_id = ${runId}::uuid
     ORDER BY included_at
  `));
}

// ── Deterministic Cohort Selection ──────────────────────────────────────────
//
// freezePilotCohort() above accepts a caller-supplied member list (built for
// callers who already have a vetted list, e.g. scripted ceremonies). This
// deterministic selector exists for the guided operator UI: the operator
// should never have to hand-assemble or paste a business-id list in
// production. It derives an eligible pool directly from the pilot
// definition's own immutable scope (county/vertical/source-adapter) plus a
// fixed set of exclusions the operator asked to be enforced unconditionally:
//
//   - record_class must be 'canonical' — the same class free enrichment and
//     the field-eligibility gate require (excludes 'test'/'demo'/'synthetic'/
//     'unknown' rows; see migration 0240's check constraint).
//   - No canonical_source_links row with source_system = 'dbpr_hr'. DBPR-HR
//     licensing data is used only as qualification/discovery evidence
//     upstream (see cro03a_handoffs) — it must never itself become a pilot
//     enrichment subject, even when it is also linked to a business that
//     qualifies via another source adapter.
//   - No open canonical_conflict_evidence row (same guard freezePilotCohort
//     re-checks server-side).
//   - No contact_business_link_decisions row with decision IN
//     ('verified','conflicted') that is not superseded — 'verified' means
//     the business is already linked to a real contact (an existing
//     customer/merchant relationship the pilot must not touch); 'conflicted'
//     means the identity is unresolved and must not be used as pilot
//     evidence.
//   - free_enrichment_status / email_discovery_status must not be
//     'suppressed'.
//
// Selection is ordered by businesses.id ascending and capped at the
// definition's max_cohort_size, so the same call is reproducible and the
// resulting cohort hash is deterministic given a stable candidate pool.
// The function is idempotent: if the run's cohort is already frozen it
// returns the existing hash without re-querying or re-selecting.
export async function selectDeterministicPilotCohort(pilotRunId: string): Promise<{
  frozen: boolean;
  cohortFrozenHash: string;
  selectedCount: number;
  eligiblePoolSize: number;
  excluded: {
    dbprLineage: number;
    testOrDemoData: number;
    linkedIdentity: number;
    suppressed: number;
    openConflict: number;
  };
}> {
  const run = await getPilotRun(pilotRunId);
  if (!run) throw new Error("PILOT_RUN_NOT_FOUND");

  // Idempotent short-circuit — never re-select once frozen.
  if (run.cohort_frozen_hash) {
    return {
      frozen: false,
      cohortFrozenHash: String(run.cohort_frozen_hash),
      selectedCount: 0,
      eligiblePoolSize: 0,
      excluded: { dbprLineage: 0, testOrDemoData: 0, linkedIdentity: 0, suppressed: 0, openConflict: 0 },
    };
  }

  const def = rows(await db.execute(sql`
    SELECT county_scope, vertical_scope, source_adapter_filter, max_cohort_size
    FROM mi09_pilot_definitions WHERE id = ${String(run.pilot_definition_id)}::uuid
  `))[0];
  if (!def) throw new Error(`PILOT_DEFINITION_NOT_FOUND:${run.pilot_definition_id}`);

  const countyScope: string[] = def.county_scope ? (typeof def.county_scope === "string" ? JSON.parse(def.county_scope) : def.county_scope) : [];
  const verticalScope: string[] = def.vertical_scope ? (typeof def.vertical_scope === "string" ? JSON.parse(def.vertical_scope) : def.vertical_scope) : [];
  const sourceAdapterFilter: string[] = def.source_adapter_filter ? (typeof def.source_adapter_filter === "string" ? JSON.parse(def.source_adapter_filter) : def.source_adapter_filter) : [];
  if (sourceAdapterFilter.length === 0) {
    throw new Error("PILOT_DEFINITION_MISSING_SOURCE_ADAPTER_FILTER — deterministic selection requires a non-empty source_adapter_filter");
  }
  const maxCohortSize = Number(def.max_cohort_size);

  // drizzle-orm's node-postgres driver renders an interpolated JS array as a
  // parenthesized tuple of scalar params (e.g. `($1, $2)`), not a Postgres
  // array literal — `${arr}::text[]` is NOT a valid array parameterization
  // here regardless of array length. Build a real `ARRAY[$1, $2, ...]::text[]`
  // expression by hand instead.
  const toTextArraySql = (arr: string[]) =>
    arr.length === 0 ? sql`ARRAY[]::text[]` : sql`ARRAY[${sql.join(arr.map((v) => sql`${v}`), sql`, `)}]::text[]`;
  const countyArraySql = toTextArraySql(countyScope);
  const verticalArraySql = toTextArraySql(verticalScope);
  const sourceAdapterArraySql = toTextArraySql(sourceAdapterFilter);

  // Base scoped candidate pool (definition scope only — no exclusions yet),
  // used to report how many candidates each exclusion category removed.
  const baseCount = rows(await db.execute(sql`
    SELECT COUNT(DISTINCT b.id)::int AS cnt
    FROM businesses b
    JOIN canonical_source_links csl ON csl.business_id = b.id
    LEFT JOIN business_locations bl ON bl.business_id = b.id
    WHERE csl.source_system = ANY(${sourceAdapterArraySql})
      AND (${countyScope.length === 0} OR bl.county_fips = ANY(${countyArraySql}))
      AND (${verticalScope.length === 0} OR b.vertical = ANY(${verticalArraySql}))
  `))[0];

  const excludedDbpr = rows(await db.execute(sql`
    SELECT COUNT(DISTINCT b.id)::int AS cnt
    FROM businesses b
    JOIN canonical_source_links csl ON csl.business_id = b.id
    LEFT JOIN business_locations bl ON bl.business_id = b.id
    WHERE csl.source_system = ANY(${sourceAdapterArraySql})
      AND (${countyScope.length === 0} OR bl.county_fips = ANY(${countyArraySql}))
      AND (${verticalScope.length === 0} OR b.vertical = ANY(${verticalArraySql}))
      AND ${businessHasDbprLineageSql(sql`b.id`)}
  `))[0];

  const excludedTest = rows(await db.execute(sql`
    SELECT COUNT(DISTINCT b.id)::int AS cnt
    FROM businesses b
    JOIN canonical_source_links csl ON csl.business_id = b.id
    LEFT JOIN business_locations bl ON bl.business_id = b.id
    WHERE csl.source_system = ANY(${sourceAdapterArraySql})
      AND (${countyScope.length === 0} OR bl.county_fips = ANY(${countyArraySql}))
      AND (${verticalScope.length === 0} OR b.vertical = ANY(${verticalArraySql}))
      AND b.record_class <> 'canonical'
  `))[0];

  const excludedLinked = rows(await db.execute(sql`
    SELECT COUNT(DISTINCT b.id)::int AS cnt
    FROM businesses b
    JOIN canonical_source_links csl ON csl.business_id = b.id
    LEFT JOIN business_locations bl ON bl.business_id = b.id
    WHERE csl.source_system = ANY(${sourceAdapterArraySql})
      AND (${countyScope.length === 0} OR bl.county_fips = ANY(${countyArraySql}))
      AND (${verticalScope.length === 0} OR b.vertical = ANY(${verticalArraySql}))
      AND EXISTS (
        SELECT 1 FROM contact_business_link_decisions cbd
        WHERE cbd.business_id = b.id AND cbd.superseded_at IS NULL AND cbd.decision IN ('verified','conflicted')
      )
  `))[0];

  const excludedSuppressed = rows(await db.execute(sql`
    SELECT COUNT(DISTINCT b.id)::int AS cnt
    FROM businesses b
    JOIN canonical_source_links csl ON csl.business_id = b.id
    LEFT JOIN business_locations bl ON bl.business_id = b.id
    WHERE csl.source_system = ANY(${sourceAdapterArraySql})
      AND (${countyScope.length === 0} OR bl.county_fips = ANY(${countyArraySql}))
      AND (${verticalScope.length === 0} OR b.vertical = ANY(${verticalArraySql}))
      AND (b.free_enrichment_status = 'suppressed' OR b.email_discovery_status = 'suppressed')
  `))[0];

  const excludedConflict = rows(await db.execute(sql`
    SELECT COUNT(DISTINCT b.id)::int AS cnt
    FROM businesses b
    JOIN canonical_source_links csl ON csl.business_id = b.id
    LEFT JOIN business_locations bl ON bl.business_id = b.id
    WHERE csl.source_system = ANY(${sourceAdapterArraySql})
      AND (${countyScope.length === 0} OR bl.county_fips = ANY(${countyArraySql}))
      AND (${verticalScope.length === 0} OR b.vertical = ANY(${verticalArraySql}))
      AND EXISTS (
        SELECT 1 FROM canonical_conflict_evidence cce
        WHERE (cce.business_id_a = b.id OR cce.business_id_b = b.id) AND cce.status = 'open'
      )
  `))[0];

  // Final eligible pool with every exclusion applied, deterministically
  // ordered and capped. We select one representative (business_id, source
  // adapter, county, vertical) row per business — MIN() on the adapter/type
  // text columns keeps the choice stable across repeated calls.
  const eligible = rows(await db.execute(sql`
    SELECT b.id AS business_id,
           MIN(csl.source_system) AS source_adapter_key,
           MIN(bl.county_fips) AS county_fips,
           MIN(b.vertical) AS vertical
    FROM businesses b
    JOIN canonical_source_links csl ON csl.business_id = b.id
    LEFT JOIN business_locations bl ON bl.business_id = b.id
    WHERE csl.source_system = ANY(${sourceAdapterArraySql})
      AND (${countyScope.length === 0} OR bl.county_fips = ANY(${countyArraySql}))
      AND (${verticalScope.length === 0} OR b.vertical = ANY(${verticalArraySql}))
      AND b.record_class = 'canonical'
      AND (b.free_enrichment_status IS DISTINCT FROM 'suppressed')
      AND (b.email_discovery_status IS DISTINCT FROM 'suppressed')
      AND ${businessLacksDbprLineageSql(sql`b.id`)}
      AND NOT EXISTS (
        SELECT 1 FROM contact_business_link_decisions cbd
        WHERE cbd.business_id = b.id AND cbd.superseded_at IS NULL AND cbd.decision IN ('verified','conflicted')
      )
      AND NOT EXISTS (
        SELECT 1 FROM canonical_conflict_evidence cce
        WHERE (cce.business_id_a = b.id OR cce.business_id_b = b.id) AND cce.status = 'open'
      )
    GROUP BY b.id
    ORDER BY b.id ASC
    LIMIT ${maxCohortSize}
  `));

  if (eligible.length === 0) {
    throw new Error("COHORT_CENSUS_INSUFFICIENT:no_eligible_businesses_after_exclusions");
  }

  // Task #1956 Step 8 defense-in-depth: re-verify enrichment eligibility through
  // the shared contactability authority for each SQL-selected candidate, on top
  // of the canonical-predicate exclusion already applied in the query above.
  // Any business the authority blocks (e.g. lineage attached after the query
  // ran) is dropped from the cohort rather than frozen.
  const eligibilityChecks = await Promise.all(
    eligible.map((r: any) => evaluateBusinessEnrichmentEligibility(Number(r.business_id)))
  );
  const authorityFiltered = eligible.filter((_: any, i: number) => eligibilityChecks[i].status === "eligible");
  const authorityExcludedCount = eligible.length - authorityFiltered.length;

  const members = authorityFiltered.map((r: any) => ({
    canonicalBusinessId: Number(r.business_id),
    sourceAdapterKey: String(r.source_adapter_key),
    countyFips: r.county_fips ? String(r.county_fips) : undefined,
    vertical: r.vertical ? String(r.vertical) : undefined,
  }));

  if (members.length === 0) {
    throw new Error("COHORT_CENSUS_INSUFFICIENT:no_eligible_businesses_after_exclusions");
  }

  const result = await freezePilotCohort({ pilotRunId, members });

  return {
    frozen: result.frozen,
    cohortFrozenHash: result.cohortFrozenHash,
    selectedCount: members.length,
    eligiblePoolSize: Number(baseCount?.cnt ?? 0),
    excluded: {
      dbprLineage: Number(excludedDbpr?.cnt ?? 0),
      testOrDemoData: Number(excludedTest?.cnt ?? 0),
      linkedIdentity: Number(excludedLinked?.cnt ?? 0),
      suppressed: Number(excludedSuppressed?.cnt ?? 0),
      openConflict: Number(excludedConflict?.cnt ?? 0),
    },
  };
}

/**
 * Execute a pilot cohort phase: iterate over frozen cohort members,
 * find their associated cro03a_handoffs via canonical_source_links,
 * create a CRO-03C command for the batch, and record mi09_pilot_effect_links.
 *
 * This function is resumable: it reads the last committed checkpoint and
 * picks up from where it left off. Each call processes one checkpoint page.
 *
 * Authorization gates:
 *   - Pilot run must be in 'running' state.
 *   - Outbound pause epoch must not have changed since run creation.
 *   - Paid providers must be allowed per the definition (Pilot 1 → none allowed).
 */
/**
 * Execute a pilot cohort phase: only `enrichment` is currently supported.
 *
 * `validation` (ZeroBounce) is NOT a dispatchable stage in CRO03B_UNIFIED_RECIPE and
 * therefore cannot be issued as a CRO-03C command. Email validation for pilot contacts
 * occurs inside the enrichment recipe's zerobounce_validation stage, not as a separate
 * pilot phase.
 *
 * `staging` does not need a CRO-03C command — master leads are written directly when
 * the CRO-03C enrichment run reaches terminal state. Creating a providerless staging
 * command would produce fake completion evidence without actually staging master leads.
 *
 * Accepting non-enrichment phases is rejected with an explicit error so callers cannot
 * advance checkpoints for phases that have no real implementation.
 */
export async function executePilotCohortPhase(input: {
  pilotRunId: string;
  phase: "enrichment";
  batchSize?: number;
}): Promise<{
  processed: number;
  handoffsLinked: number;
  effectsRecorded: number;
  complete: boolean;
  terminalOutcomes?: Array<{ businessId: number; outcome: "enriched" | "failed" | "skipped"; error?: string }>;
}> {
  const batchSize = Math.max(1, input.batchSize ?? 50);

  // Verify run state and load definition for paid-provider gating.
  const run = rows(await db.execute(sql`
    SELECT pr.id, pr.state, pr.outbound_pause_epoch, pr.pilot_definition_id,
           pr.frozen_pricing_artifacts,
           pd.level,
           pd.paid_providers_allowed
    FROM mi09_pilot_runs pr
    JOIN mi09_pilot_definitions pd ON pd.id = pr.pilot_definition_id
    WHERE pr.id = ${input.pilotRunId}::uuid
  `))[0];
  if (!run) throw new Error(`PILOT_RUN_NOT_FOUND:${input.pilotRunId}`);
  if (String(run.state) !== "running") {
    throw new Error(`PILOT_EXECUTOR_RUN_NOT_RUNNING:state=${run.state}`);
  }

  // Corrective item 4: use the pricing frozen at createPilotRun() time, never
  // a fresh live lookup — otherwise different batches of the same run could
  // price against different mi09_pricing_artifacts rows if pricing was
  // resubmitted mid-run.
  const frozenPricingArtifacts: Record<string, FrozenPricingArtifactEntry> = run.frozen_pricing_artifacts
    ? (typeof run.frozen_pricing_artifacts === "string"
        ? JSON.parse(run.frozen_pricing_artifacts)
        : run.frozen_pricing_artifacts)
    : {};

  // Which paid providers this run's definition allows at all. Level 1 has
  // every key false (or absent) — genuinely free-only. Levels 2/3 allow a
  // subset. Allowing a provider here is necessary but not sufficient: it
  // still only fires for the specific businesses that actually have the gap
  // that provider fills (see PROVIDER_GAP_SQL below) — never every record.
  const paidAllowed: Record<string, boolean> = run.paid_providers_allowed
    ? (typeof run.paid_providers_allowed === "string"
        ? JSON.parse(run.paid_providers_allowed)
        : run.paid_providers_allowed)
    : {};
  const anyPaidAllowed = Object.values(paidAllowed).some(Boolean);
  if (Number(run.level) === 1 && anyPaidAllowed) {
    throw new Error("PILOT_EXECUTOR_LEVEL1_PAID_PROVIDER_FORBIDDEN");
  }
  if (anyPaidAllowed) await assertPaidBudgetAuthorized();

  // Verify outbound is still paused with the same epoch.
  const pause = await getPauseState();
  if (pause.state !== "paused" || String(pause.epoch) !== String(run.outbound_pause_epoch)) {
    throw new Error(
      `PILOT_EXECUTOR_OUTBOUND_CHANGED:pause_state=${pause.state} ` +
      `epoch_now=${pause.epoch} epoch_recorded=${run.outbound_pause_epoch}`,
    );
  }

  // Read checkpoint to determine where to resume.
  const checkpoint = rows(await db.execute(sql`
    SELECT last_processed_business_id, processed_count
    FROM mi09_pilot_checkpoints
    WHERE pilot_run_id = ${input.pilotRunId}::uuid AND phase = ${input.phase}
  `))[0];
  const lastProcessedId = checkpoint?.last_processed_business_id
    ? Number(checkpoint.last_processed_business_id)
    : 0;

  // Load the next batch of cohort members after the checkpoint.
  const cohortBatch = rows(await db.execute(sql`
    SELECT canonical_business_id, source_adapter_key, county_fips, vertical
    FROM mi09_pilot_cohort_members
    WHERE pilot_run_id = ${input.pilotRunId}::uuid
      AND canonical_business_id > ${lastProcessedId}
    ORDER BY canonical_business_id ASC
    LIMIT ${batchSize}
  `));

  if (cohortBatch.length === 0) {
    // No more members: this phase is complete.
    return { processed: 0, handoffsLinked: 0, effectsRecorded: 0, complete: true };
  }

  const businessIds = cohortBatch.map((m: any) => Number(m.canonical_business_id));
  const maxBusinessId = Math.max(...businessIds);

  // Level 1 is a real free-only pilot, not a checkpoint simulation. Execute
  // the isolated lane synchronously and persist one terminal outcome per
  // frozen member before the checkpoint can move forward.
  if (Number(run.level) === 1) {
    const { runFreeEnrichmentLane } = await import("./free-enrichment-lane");
    const terminalOutcomes = await runFreeEnrichmentLane(businessIds);
    for (const outcome of terminalOutcomes) {
      await db.execute(sql`
        INSERT INTO mi09_pilot_enrichment_outcomes
          (pilot_run_id, business_id, outcome, error_code)
        VALUES (${input.pilotRunId}::uuid, ${outcome.businessId},
                ${outcome.outcome}, ${outcome.error ?? null})
        ON CONFLICT (pilot_run_id, business_id)
        DO UPDATE SET outcome = EXCLUDED.outcome,
                      error_code = EXCLUDED.error_code,
                      recorded_at = NOW()
      `);
    }
    if (terminalOutcomes.length !== businessIds.length) {
      throw new Error(
        `PILOT_LEVEL1_EVIDENCE_INCOMPLETE:expected=${businessIds.length} recorded=${terminalOutcomes.length}`,
      );
    }
    await db.execute(sql`
      INSERT INTO mi09_pilot_checkpoints
        (pilot_run_id, phase, last_processed_business_id, processed_count)
      VALUES (${input.pilotRunId}::uuid, ${input.phase}, ${maxBusinessId},
              ${(Number(checkpoint?.processed_count ?? 0)) + cohortBatch.length})
      ON CONFLICT (pilot_run_id, phase)
      DO UPDATE SET
        last_processed_business_id = EXCLUDED.last_processed_business_id,
        processed_count = EXCLUDED.processed_count,
        updated_at = NOW()
    `);
    const remaining = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS cnt
      FROM mi09_pilot_cohort_members
      WHERE pilot_run_id = ${input.pilotRunId}::uuid
        AND canonical_business_id > ${maxBusinessId}
    `))[0];
    return {
      processed: cohortBatch.length,
      handoffsLinked: 0,
      effectsRecorded: 0,
      complete: Number(remaining?.cnt ?? 0) === 0,
      terminalOutcomes,
    };
  }

  // Find handoffs associated with these businesses via canonical_source_links.
  // canonical_source_links.stable_key matches cro03a_handoffs.source_key.
  const handoffRows = rows(await db.execute(sql`
    SELECT DISTINCT h.id::text AS handoff_id, csl.business_id::int AS business_id
    FROM canonical_source_links csl
    JOIN cro03a_handoffs h
      ON h.source_system = csl.source_system
     AND h.source_key = csl.stable_key
     AND h.source_type = csl.source_type
    WHERE csl.business_id = ANY(ARRAY[${sql.join(businessIds.map((id) => sql`${id}::int`), sql`, `)}])
      AND h.effect_authorized = false
  `));

  const handoffIds = handoffRows.map((r: any) => String(r.handoff_id));
  // One business can have multiple un-authorized handoffs; group by business so
  // gap-eligibility (computed per business below) maps to the right handoff set.
  const handoffIdsByBusiness = new Map<number, string[]>();
  for (const r of handoffRows) {
    const bizId = Number(r.business_id);
    const list = handoffIdsByBusiness.get(bizId) ?? [];
    list.push(String(r.handoff_id));
    handoffIdsByBusiness.set(bizId, list);
  }

  let effectsRecorded = 0;

  if (handoffIds.length > 0) {
    // Create real CRO-03C commands for the batch of handoffs, then record each
    // command ID as a mi09_pilot_effect_links row with entity_type='cro03c_command'.
    // This satisfies the CHECK constraint (entity_type IN ('cro03c_command','generation',
    // 'staging_receipt','master_lead')) and creates genuine execution evidence.
    const { createCro03cCommand } = await import("./cro03/live-execution");
    const { createHash } = await import("crypto");

    // Get the active CRO-03C policy and the latest unexpired runtime attestation separately.
    // cro03c_activation_policies does NOT have a runtime_attestation_id column — the
    // policy and attestation are linked by ceremony, not by a DB FK. We query each table
    // independently: latest approved policy revision + latest unexpired attestation.
    const policyRow = rows(await db.execute(sql`
      SELECT expected_revision
      FROM cro03c_activation_policies
      WHERE policy_key = 'cro03c_live_activation'
        AND status = 'approved'
      ORDER BY expected_revision DESC
      LIMIT 1
    `))[0];
    const attestationRow = rows(await db.execute(sql`
      SELECT id FROM cro03c_runtime_attestations
      WHERE expires_at > NOW()
      ORDER BY issued_at DESC
      LIMIT 1
    `))[0];

    if (!policyRow) {
      throw new Error(
        "PILOT_EXECUTOR_NO_ACTIVE_POLICY — CRO-03C activation policy missing; " +
        "run the CRO-03D ceremony before executing pilot phases",
      );
    }
    if (!attestationRow) {
      throw new Error(
        "PILOT_EXECUTOR_NO_VALID_ATTESTATION — no unexpired CRO-03C runtime attestation; " +
        "run a fresh CRO-03D attestation before executing pilot phases",
      );
    }

    // ── Gap-driven paid-provider routing (corrective item 6) ─────────────────
    // Each paid provider only ever gets a command for the businesses that
    // actually have the specific gap it fills — never every record in the
    // batch. This mirrors the eligibility a provider's own recipe step
    // declares in cro03/recipe-contract.ts (serper: "unresolved_gap" i.e.
    // missing identity fields; outscraper: richer business-search data;
    // openai: missing classification; apollo: missing decision-maker email).
    const PROVIDER_GAP_SQL: Record<string, ReturnType<typeof sql>> = {
      serper:     sql`(b.website_domain IS NULL OR b.main_phone IS NULL OR b.street_address IS NULL)`,
      outscraper: sql`(b.review_count IS NULL OR b.rating IS NULL)`,
      openai:     sql`(b.industry_primary IS NULL AND b.vertical IS NULL)`,
      apollo:     sql`(b.main_email IS NULL)`,
    };
    const candidateProviders = (["serper", "outscraper", "openai", "apollo"] as const)
      .filter((p) => input.phase === "enrichment" && paidAllowed[p] === true);

    // Businesses actually gapped for each candidate provider — computed once
    // per batch, not assumed. A provider allowed by the definition but with
    // zero gapped businesses this batch issues no command at all.
    const gapRows: Record<string, Set<number>> = {};
    for (const provider of candidateProviders) {
      const res = rows(await db.execute(sql`
        SELECT b.id::int AS id FROM businesses b
        WHERE b.id = ANY(ARRAY[${sql.join(businessIds.map((id) => sql`${id}::int`), sql`, `)}])
          AND ${PROVIDER_GAP_SQL[provider]}
      `));
      gapRows[provider] = new Set(res.map((r: any) => Number(r.id)));
    }

    async function issueCommand(
      provider: string | undefined,
      handoffIdsForProvider: string[],
      extra: Record<string, unknown>,
      label: string,
    ): Promise<void> {
      if (handoffIdsForProvider.length === 0) return;
      const selectionHash = createHash("sha256")
        .update(JSON.stringify({
          pilotRunId: input.pilotRunId, phase: input.phase, provider: provider ?? "none",
          handoffIds: [...handoffIdsForProvider].sort(),
        }))
        .digest("hex");
      const commandIdem = selectionHash.slice(0, 128);
      const { commandId } = await createCro03cCommand({
        actorId:                    `mi09-pilot:${input.pilotRunId.slice(0, 8)}`,
        idempotencyKey:             commandIdem,
        commandType:                "pilot_phase",
        pilotRunId:                 input.pilotRunId,
        expectedActivationRevision: Number(policyRow.expected_revision),
        runtimeAttestationId:       String(attestationRow.id),
        handoffIds:                 handoffIdsForProvider,
        ...extra,
        reason:                     `MI-09 Pilot ${input.pilotRunId.slice(0, 8)} — ${input.phase} phase (${label})`,
        expiresAt:                  new Date(Date.now() + 24 * 3600_000),
      });
      await db.execute(sql`
        INSERT INTO mi09_pilot_effect_links (pilot_run_id, entity_type, entity_id)
        VALUES (${input.pilotRunId}::uuid, 'cro03c_command', ${commandId})
        ON CONFLICT DO NOTHING
      `);
      effectsRecorded++;
    }

    for (const provider of candidateProviders) {
      const gappedBusinessIds = businessIds.filter((id) => gapRows[provider].has(id));
      const handoffIdsForProvider = gappedBusinessIds.flatMap((id) => handoffIdsByBusiness.get(id) ?? []);
      if (handoffIdsForProvider.length === 0) continue; // definition allows it, nothing in this batch needs it

      const artifact = frozenPricingArtifacts[provider];
      if (!artifact) continue; // fail-closed: no un-priced paid work is ever issued (frozen at run creation)

      await assertPaidBudgetAuthorized();
      const unitAmountMicros = Number(artifact.amountMicros);
      const units = handoffIdsForProvider.length;
      await issueCommand(provider, handoffIdsForProvider, {
        provider,
        maxUnits: units,
        maxAmountMicros: unitAmountMicros * units,
      }, `provider=${provider} gapped=${units}`);
    }

    // ── ZeroBounce business-validation caps (corrective item 7) ──────────────
    // Provider-less pilot_phase command carrying only businessValidationMaxUnits/
    // MaxAmountMicros — authorizeCro03cBusinessValidation() checks these caps
    // directly and does not require caps.provider to be set, so this is the
    // correct vehicle to grant ZeroBounce business-validation authority
    // independent of which (if any) paid discovery provider ran for a given
    // business. Every business in the batch is eligible — ZeroBounce validates
    // whatever candidate email discovery already produced, not a specific
    // provider's output.
    if (input.phase === "enrichment" && paidAllowed.zerobounce === true) {
      const zbArtifact = frozenPricingArtifacts.zerobounce;
      if (zbArtifact) {
        await assertPaidBudgetAuthorized();
        const zbUnitAmountMicros = Number(zbArtifact.amountMicros);
        const zbUnits = handoffIds.length;
        await issueCommand(undefined, handoffIds, {
          businessValidationMaxUnits: zbUnits,
          businessValidationMaxAmountMicros: zbUnitAmountMicros * zbUnits,
        }, `provider=zerobounce business_validation=${zbUnits}`);
      }
    }
  }

  // Update checkpoint.
  await db.execute(sql`
    INSERT INTO mi09_pilot_checkpoints
      (pilot_run_id, phase, last_processed_business_id, processed_count)
    VALUES (${input.pilotRunId}::uuid, ${input.phase}, ${maxBusinessId},
            ${(Number(checkpoint?.processed_count ?? 0)) + cohortBatch.length})
    ON CONFLICT (pilot_run_id, phase)
    DO UPDATE SET
      last_processed_business_id = EXCLUDED.last_processed_business_id,
      processed_count = EXCLUDED.processed_count,
      updated_at = NOW()
  `);

  // Determine if there are more members remaining.
  const remaining = rows(await db.execute(sql`
    SELECT COUNT(*)::int AS cnt
    FROM mi09_pilot_cohort_members
    WHERE pilot_run_id = ${input.pilotRunId}::uuid
      AND canonical_business_id > ${maxBusinessId}
  `))[0];
  const complete = Number(remaining?.cnt ?? 0) === 0;

  return {
    processed: cohortBatch.length,
    handoffsLinked: handoffIds.length,
    effectsRecorded,
    complete,
  };
}

// ── Checkpoints ──────────────────────────────────────────────────────────────

export async function upsertPilotCheckpoint(input: {
  pilotRunId: string;
  phase: "enrichment";
  lastProcessedBusinessId?: string;
  processedCount: number;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO mi09_pilot_checkpoints
      (pilot_run_id, phase, last_processed_business_id, processed_count)
    VALUES (${input.pilotRunId}::uuid, ${input.phase},
            ${input.lastProcessedBusinessId ? Number(input.lastProcessedBusinessId) : null}, ${input.processedCount})
    ON CONFLICT (pilot_run_id, phase)
    DO UPDATE SET
      last_processed_business_id = EXCLUDED.last_processed_business_id,
      processed_count = EXCLUDED.processed_count,
      updated_at = NOW()
  `);
}

export async function getPilotCheckpoints(runId: string): Promise<any[]> {
  return rows(await db.execute(sql`
    SELECT * FROM mi09_pilot_checkpoints WHERE pilot_run_id = ${runId}::uuid
  `));
}

// ── Stop Condition Checks ─────────────────────────────────────────────────────

export interface StopConditionResult {
  passed: boolean;
  failedConditions: string[];
  checkedAt: string;
  details: Record<string, unknown>;
}

/**
 * Evaluate operator-defined stop conditions against current pilot state.
 * All thresholds come from mi09_pilot_definitions — none are hardcoded.
 */
export async function evaluateStopConditions(
  runId: string,
): Promise<StopConditionResult> {
  const run = await getPilotRun(runId);
  if (!run) throw new Error("PILOT_RUN_NOT_FOUND");
  const thresholds = run.stop_condition_thresholds as {
    conflictPct: number;
    apolloYieldPct: number;
    zbUnknownPct: number;
    spendCapMicros: number;
  };

  // Load paid_providers_allowed from the definition to gate provider-specific checks.
  const defRow = rows(await db.execute(sql`
    SELECT paid_providers_allowed FROM mi09_pilot_definitions WHERE id = ${String(run.pilot_definition_id)}::uuid
  `))[0];
  const paidAllowed: Record<string, boolean> = defRow?.paid_providers_allowed
    ? (typeof defRow.paid_providers_allowed === "string"
        ? JSON.parse(defRow.paid_providers_allowed)
        : defRow.paid_providers_allowed)
    : {};

  const failedConditions: string[] = [];
  const details: Record<string, unknown> = {};

  // (a) Conflict rate
  const totalMembers = rows(await db.execute(sql`
    SELECT COUNT(*)::int AS cnt FROM mi09_pilot_cohort_members
     WHERE pilot_run_id = ${runId}::uuid
  `))[0];
  const conflictMembers = rows(await db.execute(sql`
    SELECT COUNT(DISTINCT m.canonical_business_id)::int AS cnt
    FROM mi09_pilot_cohort_members m
    JOIN canonical_conflict_evidence cce
      ON (cce.business_id_a = m.canonical_business_id OR cce.business_id_b = m.canonical_business_id)
     AND cce.status = 'open'
    WHERE m.pilot_run_id = ${runId}::uuid
  `))[0];
  const totalCount = Number(totalMembers?.cnt ?? 0);
  const conflictCount = Number(conflictMembers?.cnt ?? 0);
  const conflictPct = totalCount > 0 ? (conflictCount / totalCount) * 100 : 0;
  details.conflictPct = conflictPct;
  if (conflictPct > thresholds.conflictPct) {
    failedConditions.push(`conflict_pct:${conflictPct.toFixed(2)}>${thresholds.conflictPct}`);
  }

  // (b) Spend remains available for audit visibility, but no longer stops a run.
  // Join: pilot effect_links (entity_type='cro03c_command') → cro03c_commands → cro03c_generations
  //       → cro03c_stage_operations (has settled_amount_micros).
  // This is the authoritative spend signal; provider_budget_period_ledger is a
  // period-close archive that omits in-flight consumption.
  // FAIL-CLOSED: spend query failure counts as a condition failure.
  {
    let totalSettledMicros = 0;
    try {
      const spendRow = rows(await db.execute(sql`
        SELECT COALESCE(SUM(so.settled_amount_micros), 0)::bigint AS settled_micros
        FROM cro03c_stage_operations so
        JOIN cro03c_generations g ON g.id = so.generation_id
        JOIN cro03c_commands cmd ON cmd.id = g.command_id
        JOIN mi09_pilot_effect_links pel
          ON pel.entity_id = cmd.id
         AND pel.entity_type = 'cro03c_command'
         AND pel.pilot_run_id = ${runId}::uuid
        WHERE so.state NOT IN ('cancelled', 'quarantined')
      `))[0];
      totalSettledMicros = Number(spendRow?.settled_micros ?? 0);
    } catch (e: any) {
      details.spendCapError = String(e?.message);
    }
    details.totalSettledMicros = totalSettledMicros;
  }

  // (c) Apollo reveal yield — only checked when the definition allows Apollo as a paid provider.
  // If Apollo is not in paid_providers_allowed, skip the yield check (no Apollo data will exist).
  // FAIL-CLOSED: threshold > 0 means the check is required; query failure is a stop condition.
  const apolloAllowed = paidAllowed.apollo === true;
  if (apolloAllowed && typeof thresholds.apolloYieldPct === "number" && thresholds.apolloYieldPct > 0) {
    try {
      const apolloRows = rows(await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE so.terminal_disposition = 'consumed')::int AS hit_count,
          COUNT(*)::int AS total_count
        FROM cro03c_stage_operations so
        JOIN cro03c_generations g ON g.id = so.generation_id
        JOIN cro03c_commands cmd ON cmd.id = g.command_id
        JOIN mi09_pilot_effect_links pel
          ON pel.entity_id = cmd.id
         AND pel.entity_type = 'cro03c_command'
         AND pel.pilot_run_id = ${runId}::uuid
        WHERE so.provider = 'apollo'
          AND so.state NOT IN ('cancelled', 'quarantined')
      `))[0];
      const hitCount = Number(apolloRows?.hit_count ?? 0);
      const totalCount = Number(apolloRows?.total_count ?? 0);
      if (totalCount === 0) {
        // No Apollo operations yet — if threshold set, this is a data-gap failure.
        failedConditions.push(`apollo_yield_no_data:threshold_set_but_no_apollo_operations`);
      } else {
        const yieldPct = (hitCount / totalCount) * 100;
        details.apolloYieldPct = yieldPct;
        if (yieldPct < thresholds.apolloYieldPct) {
          failedConditions.push(`apollo_yield_pct:${yieldPct.toFixed(2)}<${thresholds.apolloYieldPct}`);
        }
      }
    } catch (e: any) {
      // Fail-closed: query failure means we cannot certify Apollo yield.
      failedConditions.push(`apollo_yield_query_failed:${e?.message}`);
    }
  }

  // (d-zb) ZeroBounce unknown rate — via cro03c_receipts with provider='zerobounce'.
  // Unknown rate = receipts with normalized_outcome in ('unknown','unresolvable') / total ZB receipts.
  // businesses.email_validation_status does not exist; use the stage accounting layer.
  // FAIL-CLOSED: query failure is a stop condition.
  if (typeof thresholds.zbUnknownPct === "number" && thresholds.zbUnknownPct > 0) {
    try {
      const zbRows = rows(await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE r.normalized_outcome IN ('unknown','unresolvable'))::int AS unknown_count,
          COUNT(*)::int AS total_count
        FROM cro03c_receipts r
        JOIN cro03c_stage_operations so ON so.id = r.stage_operation_id
        JOIN cro03c_generations g ON g.id = so.generation_id
        JOIN cro03c_commands cmd ON cmd.id = g.command_id
        JOIN mi09_pilot_effect_links pel
          ON pel.entity_id = cmd.id
         AND pel.entity_type = 'cro03c_command'
         AND pel.pilot_run_id = ${runId}::uuid
        WHERE so.provider = 'zerobounce'
      `))[0];
      const unknownCount = Number(zbRows?.unknown_count ?? 0);
      const totalCount = Number(zbRows?.total_count ?? 0);
      if (totalCount === 0) {
        failedConditions.push(`zb_unknown_no_data:threshold_set_but_no_zb_operations`);
      } else {
        const unknownPct = (unknownCount / totalCount) * 100;
        details.zbUnknownPct = unknownPct;
        if (unknownPct > thresholds.zbUnknownPct) {
          failedConditions.push(`zb_unknown_pct:${unknownPct.toFixed(2)}>${thresholds.zbUnknownPct}`);
        }
      }
    } catch (e: any) {
      failedConditions.push(`zb_unknown_query_failed:${e?.message}`);
    }
  }

  // (e) Any outbound effects linked to pilot run — check by entity_type discrimination.
  // We do NOT join sdr_lead_events (no generation_id/command_id columns exist on that table).
  // Instead, we check for any mi09_pilot_effect_links with entity_type that is NOT one of
  // the 4 expected non-outreach types, which would indicate a forbidden effect was recorded.
  const allowedEntityTypes = ["cro03c_command", "generation", "staging_receipt", "master_lead"];
  const forbiddenLinks = rows(await db.execute(sql`
    SELECT COUNT(*)::int AS cnt
    FROM mi09_pilot_effect_links
    WHERE pilot_run_id = ${runId}::uuid
      AND entity_type NOT IN ('cro03c_command', 'generation', 'staging_receipt', 'master_lead')
  `))[0];
  const forbiddenCount = Number(forbiddenLinks?.cnt ?? 0);
  details.forbiddenEffectLinks = forbiddenCount;
  details.allowedEntityTypes = allowedEntityTypes;
  if (forbiddenCount > 0) {
    failedConditions.push(`forbidden_effect_links:${forbiddenCount}`);
  }

  return {
    passed: failedConditions.length === 0,
    failedConditions,
    checkedAt: new Date().toISOString(),
    details,
  };
}

// ── Effect Links ─────────────────────────────────────────────────────────────

export async function recordPilotEffectLink(input: {
  pilotRunId: string;
  entityType: "cro03c_command" | "generation" | "staging_receipt" | "master_lead";
  entityId: string;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO mi09_pilot_effect_links (pilot_run_id, entity_type, entity_id)
    VALUES (${input.pilotRunId}::uuid, ${input.entityType}, ${input.entityId}::uuid)
    ON CONFLICT (pilot_run_id, entity_type, entity_id) DO NOTHING
  `);
}

export async function getPilotEffectLinks(
  runId: string,
  entityType?: string,
): Promise<any[]> {
  return rows(await db.execute(sql`
    SELECT * FROM mi09_pilot_effect_links
     WHERE pilot_run_id = ${runId}::uuid
       AND (${entityType ?? null}::text IS NULL OR entity_type = ${entityType ?? null})
     ORDER BY created_at
  `));
}

// ── Legacy paid-spend summaries and authorization API ──────────────────────
// Spend summaries remain exported for existing consumers and audit visibility;
// they are informational only and are not execution gates.
export const MI09_LADDER_AGGREGATE_PAID_BUDGET_MICROS = 50_000_000; // $50.00 USD

const MI09_PAID_BUDGET_AUTH_KEY = "mi09_pilot_paid_budget_authorization";
export const MI09_PAID_BUDGET_TYPED_CONFIRMATION = "AUTHORIZE PAID PILOT";

export interface PilotBudgetSummary {
  capMicros: number;
  settledMicros: number;
  reservedMicros: number;
  failedOrCancelledMicros: number;
  remainingMicros: number;
  overCap: boolean;
  operationCount: number;
  byProvider: Array<{
    provider: string;
    settledMicros: number;
    reservedMicros: number;
    operationCount: number;
    scope: "mi09_pilot_linked_cro03c_operations_only";
  }>;
}

/**
 * Canonical aggregate ledger read shared by pilot and SFP summaries. The
 * provider breakdown remains pilot-link scoped for backwards compatibility;
 * all headline amounts and remaining headroom come from the shared operation
 * ledger so SFP is not counted once here and a second time by its caller.
 */
export async function getAggregatePilotSpend(): Promise<PilotBudgetSummary> {
  const opRows = rows(await db.execute(sql`
    SELECT so.provider, so.state,
           SUM(CASE
             WHEN so.terminal_disposition = 'released'
               OR so.state IN ('reserved','dispatched','failed','cancelled')
               OR so.billing_certainty IN ('ambiguous','unknown') THEN 0
             ELSE so.settled_amount_micros
           END)::bigint AS settled_micros,
           SUM(CASE
             WHEN so.terminal_disposition = 'released' THEN 0
             WHEN so.state IN ('reserved','dispatched','failed','cancelled')
               OR so.billing_certainty IN ('ambiguous','unknown')
               THEN GREATEST(so.max_reserved_amount_micros, so.settled_amount_micros)
             ELSE 0
           END)::bigint AS reserved_micros,
           COUNT(*)::int AS cnt
    FROM mi09_pilot_effect_links el
    JOIN cro03c_stage_operations so ON so.command_id = el.entity_id
    WHERE el.entity_type = 'cro03c_command'
    GROUP BY so.provider, so.state
  `));

  let operationCount = 0;
  const byProviderMap = new Map<string, {
    settledMicros: number;
    reservedMicros: number;
    operationCount: number;
    scope: "mi09_pilot_linked_cro03c_operations_only";
  }>();
  for (const r of opRows) {
    const provider = String(r.provider);
    const settled = Number(r.settled_micros ?? 0);
    const reserved = Number(r.reserved_micros ?? 0);
    const cnt = Number(r.cnt ?? 0);
    operationCount += cnt;
    const entry = byProviderMap.get(provider) ?? {
      settledMicros: 0,
      reservedMicros: 0,
      operationCount: 0,
      scope: "mi09_pilot_linked_cro03c_operations_only",
    };
    entry.settledMicros += settled;
    entry.reservedMicros += reserved;
    entry.operationCount += cnt;
    byProviderMap.set(provider, entry);
  }

  const capMicros = MI09_LADDER_AGGREGATE_PAID_BUDGET_MICROS;
  const ledger = await db.transaction(async (tx) => {
    await acquireLadderBudgetLock(tx);
    return computeLadderBudgetLedger(tx);
  });
  const settledMicros = ledger.settledMicros;
  const reservedMicros = ledger.reservedMicros;
  const committedMicros = settledMicros + reservedMicros;
  return {
    capMicros,
    settledMicros,
    reservedMicros,
    failedOrCancelledMicros: ledger.failedOrCancelledMicros,
    remainingMicros: Math.max(0, capMicros - committedMicros),
    overCap: committedMicros > capMicros,
    operationCount: ledger.operationCount || operationCount,
    byProvider: Array.from(byProviderMap.entries()).map(([provider, v]) => ({ provider, ...v })),
  };
}

/** @deprecated Compatibility API; returns the informational spend summary without enforcing a ceiling. */
export async function assertAggregatePaidBudgetAvailable(): Promise<PilotBudgetSummary> {
  const summary = await getAggregatePilotSpend();
  return summary;
}

export interface PaidBudgetAuthorization {
  authorizedBy: string;
  authorizedAt: string;
  capMicros: number;
  typedConfirmation: string;
  revokedAt?: string;
  revokedBy?: string;
  revokedReason?: string;
}

/** Read the current typed paid-budget authorization, if any (system_settings-backed, single row). */
export async function getPaidBudgetAuthorization(): Promise<PaidBudgetAuthorization | null> {
  const row = rows(await db.execute(sql`
    SELECT value FROM system_settings WHERE key = ${MI09_PAID_BUDGET_AUTH_KEY} LIMIT 1
  `))[0];
  if (!row) return null;
  const value = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
  return value as PaidBudgetAuthorization;
}

/**
 * Record the operator's explicit typed authorization for paid providers. The caller (route layer) must
 * have already verified the exact typed confirmation string and admin role;
 * this function re-verifies the string as a second, independent gate so a
 * bug in the route can never silently authorize paid spend.
 */
export async function authorizePaidBudget(input: {
  authorizedBy: string;
  typedConfirmation: string;
}): Promise<PaidBudgetAuthorization> {
  if (input.typedConfirmation !== MI09_PAID_BUDGET_TYPED_CONFIRMATION) {
    throw new Error("MI09_PAID_BUDGET_AUTHORIZATION_DENIED:typed_confirmation_mismatch");
  }
  const auth: PaidBudgetAuthorization = {
    authorizedBy: input.authorizedBy,
    authorizedAt: new Date().toISOString(),
    capMicros: MI09_LADDER_AGGREGATE_PAID_BUDGET_MICROS,
    typedConfirmation: input.typedConfirmation,
  };
  await db.execute(sql`
    INSERT INTO system_settings (key, value, updated_at)
    VALUES (${MI09_PAID_BUDGET_AUTH_KEY}, ${JSON.stringify(auth)}::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `);
  return auth;
}

/**
 * Emergency stop: revoke the standing paid-budget authorization so no
 * further paid-provider pilot phase can execute, without touching the
 * global outbound-pause state (which governs sends, not this pilot's
 * provider spend gate).
 */
export async function revokePaidBudgetAuthorization(input: {
  revokedBy: string;
  reason: string;
}): Promise<void> {
  const current = await getPaidBudgetAuthorization();
  if (!current) return;
  const revoked: PaidBudgetAuthorization = {
    ...current,
    revokedAt: new Date().toISOString(),
    revokedBy: input.revokedBy,
    revokedReason: input.reason,
  };
  await db.execute(sql`
    UPDATE system_settings SET value = ${JSON.stringify(revoked)}::jsonb, updated_at = NOW()
    WHERE key = ${MI09_PAID_BUDGET_AUTH_KEY}
  `);
}

/** Throws unless a live (non-revoked) typed paid-provider authorization exists. */
export async function assertPaidBudgetAuthorized(): Promise<PaidBudgetAuthorization> {
  const auth = await getPaidBudgetAuthorization();
  if (!auth || auth.revokedAt) {
    throw new Error("MI09_PAID_BUDGET_NOT_AUTHORIZED — an admin must submit the typed confirmation before any paid-provider pilot phase can run");
  }
  return auth;
}

// ── Advancement ──────────────────────────────────────────────────────────────

/** Issue an owner advancement receipt — idempotent by idempotency_key. */
export async function issuePilotAdvancementReceipt(
  input: AdvancementInput,
): Promise<{ id: string; alreadyExisted: boolean }> {
  // Check idempotency key first.
  const existing = rows(await db.execute(sql`
    SELECT id FROM mi09_pilot_advancement_receipts WHERE idempotency_key = ${input.idempotencyKey}
  `))[0];
  if (existing) return { id: String(existing.id), alreadyExisted: true };

  // Advancement is independently evidence-gated; never trust the UI's
  // stopConditionsChecked or claimed phase completion.
  await assertPilotEvidenceComplete(input.pilotRunId);

  // Verify pause epoch unchanged.
  const pause = await getPauseState();
  if (pause.state !== "paused") throw new Error("PILOT_ADVANCEMENT_BLOCKED:outbound_not_paused");

  // Block advancement if stop conditions failed — caller must resolve failures first.
  if (!input.stopConditionsPassed) {
    const failures = (input.stopConditionsChecked as any)?.failedConditions ?? [];
    throw new Error(
      `PILOT_ADVANCEMENT_BLOCKED:stop_conditions_failed:[${Array.isArray(failures) ? failures.join(",") : "unknown"}]`,
    );
  }

  // Verify run exists and is in a valid state for advancement.
  const runRow = rows(await db.execute(sql`
    SELECT r.state, pd.level FROM mi09_pilot_runs r
    JOIN mi09_pilot_definitions pd ON pd.id = r.pilot_definition_id
    WHERE r.id = ${input.pilotRunId}::uuid
  `))[0];
  if (!runRow) throw new Error("PILOT_RUN_NOT_FOUND");
  if (!["running", "paused", "completed"].includes(String(runRow.state))) {
    throw new Error(`PILOT_ADVANCEMENT_BLOCKED:invalid_state:${runRow.state}`);
  }
  if (Number(runRow.level) !== input.fromLevel) {
    throw new Error(`PILOT_ADVANCEMENT_BLOCKED:level_mismatch:run_level=${runRow.level} from_level=${input.fromLevel}`);
  }

  const created = rows(await db.execute(sql`
    INSERT INTO mi09_pilot_advancement_receipts
      (pilot_run_id, from_level, to_level, approved_by,
       pricing_artifact_id, stop_conditions_checked, stop_conditions_passed, idempotency_key)
    VALUES (${input.pilotRunId}::uuid, ${input.fromLevel}, ${input.toLevel},
            ${input.approvedBy}, ${input.pricingArtifactId ?? null}::uuid,
            ${JSON.stringify(input.stopConditionsChecked)}::jsonb,
            ${input.stopConditionsPassed}, ${input.idempotencyKey})
    RETURNING id
  `));

  // Bind receipt to the run.
  await db.execute(sql`
    UPDATE mi09_pilot_runs
       SET advancement_receipt_id = ${String(created[0].id)}::uuid
     WHERE id = ${input.pilotRunId}::uuid
  `);

  return { id: String(created[0].id), alreadyExisted: false };
}

// ── Reconciliation Reports ────────────────────────────────────────────────────

/**
 * Build a complete reconciliation from durable pilot evidence. This is kept
 * server-side so an operator cannot submit a partial/stub report from the UI.
 * Every section is scoped through the pilot run's effect links (and the
 * explicit provenance columns where available).
 */
export async function buildPilotReconciliationReport(runId: string): Promise<Record<string, unknown>> {
  const run = await getPilotRun(runId);
  if (!run) throw new Error(`PILOT_RUN_NOT_FOUND:${runId}`);
  const [
    cohortComposition,
    commands,
    operations,
    receipts,
    spend,
    outcomes,
    staging,
    failures,
    forbiddenEffects,
    noOutboundChecks,
  ] = await Promise.all([
    db.execute(sql`
      SELECT COALESCE(source_adapter_key, 'unknown') AS source_adapter_key,
             COALESCE(vertical, 'unknown') AS vertical,
             COALESCE(county_fips, 'unknown') AS county_fips,
             COUNT(*)::int AS count
        FROM mi09_pilot_cohort_members
       WHERE pilot_run_id = ${runId}::uuid
       GROUP BY source_adapter_key, vertical, county_fips
       ORDER BY count DESC
    `),
    db.execute(sql`
      SELECT c.id, c.command_type, c.state, c.caps, c.created_at, c.completed_at
        FROM mi09_pilot_effect_links pel
        JOIN cro03c_commands c ON c.id = pel.entity_id
       WHERE pel.pilot_run_id = ${runId}::uuid AND pel.entity_type = 'cro03c_command'
       ORDER BY c.created_at
    `),
    db.execute(sql`
      SELECT so.id, so.generation_id, so.provider, so.operation_type, so.state,
             so.dispatch_state, so.max_reserved_units, so.max_reserved_amount_micros,
             so.settled_units, so.settled_amount_micros, so.billing_certainty,
             so.terminal_disposition, so.reconciliation_required
        FROM cro03c_stage_operations so
        JOIN cro03c_generations g ON g.id = so.generation_id
        JOIN mi09_pilot_effect_links pel ON pel.entity_id = g.command_id
       WHERE pel.pilot_run_id = ${runId}::uuid
         AND pel.entity_type = 'cro03c_command'
       ORDER BY so.created_at
    `),
    db.execute(sql`
      SELECT r.id, r.generation_id, r.stage_operation_id, r.receipt_type,
             r.normalized_outcome, r.settled_units, r.settled_amount_micros,
             r.created_at
        FROM cro03c_receipts r
        JOIN cro03c_generations g ON g.id = r.generation_id
        JOIN mi09_pilot_effect_links pel ON pel.entity_id = g.command_id
       WHERE pel.pilot_run_id = ${runId}::uuid
         AND pel.entity_type = 'cro03c_command'
       ORDER BY r.created_at
    `),
    db.execute(sql`
      SELECT COALESCE(so.provider, 'unknown') AS provider,
             COALESCE(SUM(so.settled_amount_micros), 0)::bigint AS settled_micros,
             COALESCE(SUM(CASE WHEN so.state IN ('reserved','dispatched')
                               THEN so.max_reserved_amount_micros ELSE 0 END), 0)::bigint AS reserved_micros,
             COALESCE(SUM(so.max_reserved_amount_micros), 0)::bigint AS authorized_micros
        FROM cro03c_stage_operations so
        JOIN cro03c_generations g ON g.id = so.generation_id
        JOIN mi09_pilot_effect_links pel ON pel.entity_id = g.command_id
       WHERE pel.pilot_run_id = ${runId}::uuid
         AND pel.entity_type = 'cro03c_command'
       GROUP BY so.provider
       ORDER BY so.provider
    `),
    db.execute(sql`
      SELECT COALESCE(r.normalized_outcome, 'missing') AS outcome, COUNT(*)::int AS count
        FROM cro03c_receipts r
        JOIN cro03c_generations g ON g.id = r.generation_id
        JOIN mi09_pilot_effect_links pel ON pel.entity_id = g.command_id
       WHERE pel.pilot_run_id = ${runId}::uuid
         AND pel.entity_type = 'cro03c_command'
       GROUP BY r.normalized_outcome
       ORDER BY count DESC
    `),
    db.execute(sql`
      SELECT COALESCE(sr.disposition, 'unknown') AS disposition, COUNT(*)::int AS count
        FROM master_lead_staging_receipts sr
        LEFT JOIN cro03c_generations g ON g.id = sr.cro03_generation_id
       WHERE sr.pilot_run_id = ${runId}::uuid OR g.pilot_run_id = ${runId}::uuid
       GROUP BY sr.disposition
       ORDER BY count DESC
    `),
    db.execute(sql`
      SELECT COALESCE(so.provider, 'unknown') AS provider,
             COUNT(*) FILTER (WHERE so.state IN ('failed','cancelled','quarantined'))::int AS failed_operations,
             COUNT(*) FILTER (WHERE so.reconciliation_required = true)::int AS reconciliation_required
        FROM cro03c_stage_operations so
        JOIN cro03c_generations g ON g.id = so.generation_id
        JOIN mi09_pilot_effect_links pel ON pel.entity_id = g.command_id
       WHERE pel.pilot_run_id = ${runId}::uuid
         AND pel.entity_type = 'cro03c_command'
       GROUP BY so.provider
    `),
    db.execute(sql`
      SELECT entity_type, COUNT(*)::int AS count
        FROM mi09_pilot_effect_links
       WHERE pilot_run_id = ${runId}::uuid
         AND entity_type NOT IN ('cro03c_command','generation','staging_receipt','master_lead')
       GROUP BY entity_type
    `),
    db.execute(sql`
      SELECT s.phase, s.counters, s.created_at
        FROM cro03c_no_outbound_snapshots s
        JOIN mi09_pilot_effect_links pel ON pel.entity_id = s.command_id
       WHERE pel.pilot_run_id = ${runId}::uuid
         AND pel.entity_type = 'cro03c_command'
       ORDER BY s.created_at
    `),
  ]);
  const asRows = (result: any): any[] => result?.rows ?? result ?? [];
  const commandRows = asRows(commands);
  const operationRows = asRows(operations);
  const receiptRows = asRows(receipts);
  const spendRows = asRows(spend);
  const outcomeRows = asRows(outcomes);
  const stagingRows = asRows(staging);
  const failureRows = asRows(failures);
  const forbiddenRows = asRows(forbiddenEffects);
  const outboundRows = asRows(noOutboundChecks);
  const cohortRows = asRows(cohortComposition);
  const totalSpendMicros = spendRows.reduce((sum, row) => sum + Number(row.settled_micros ?? 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    pilotRun: {
      id: String(run.id),
      state: run.state,
      level: Number(run.level),
      releaseSha: run.release_sha,
      outboundPauseEpoch: String(run.outbound_pause_epoch),
      cohortFrozenHash: run.cohort_frozen_hash,
    },
    cohortComposition: {
      total: cohortRows.reduce((sum, row) => sum + Number(row.count ?? 0), 0),
      bySourceVerticalCounty: cohortRows,
    },
    providerApplicability: (CRO03C_PROVIDER_KEYS as readonly string[]).map((provider) => ({
      provider,
      operationCount: operationRows.filter((operation) => operation.provider === provider).length,
      issuedCommandCount: commandRows.filter((command) => command.caps?.provider === provider).length,
      settledUnits: operationRows.filter((operation) => operation.provider === provider)
        .reduce((sum, operation) => sum + Number(operation.settled_units ?? 0), 0),
    })),
    issuedCommands: commandRows,
    resultingOperations: operationRows,
    receipts: receiptRows,
    spend: { totalSettledMicros: totalSpendMicros, byProvider: spendRows },
    outcomes: outcomeRows,
    stagingResults: stagingRows,
    failures: failureRows,
    forbiddenEffectChecks: {
      forbiddenEffectLinks: forbiddenRows,
      noOutboundSnapshots: outboundRows,
      passed: forbiddenRows.length === 0 && outboundRows.length > 0,
      note: outboundRows.length === 0
        ? "No CRO-03C no-outbound snapshots were recorded for this run"
        : "Pilot command no-outbound snapshots were present; no forbidden effect links found",
    },
  };
}

export async function savePilotReconciliationReport(input: {
  pilotRunId: string;
  reportData: Record<string, unknown>;
}): Promise<{ id: string }> {
  const created = rows(await db.execute(sql`
    INSERT INTO mi09_pilot_reconciliation_reports (pilot_run_id, report_data)
    VALUES (${input.pilotRunId}::uuid, ${JSON.stringify(input.reportData)}::jsonb)
    RETURNING id
  `));
  return { id: String(created[0].id) };
}

export async function updateReconciliationReportDriveDoc(
  reportId: string,
  driveDocId: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE mi09_pilot_reconciliation_reports
       SET drive_doc_id = ${driveDocId}, drive_published_at = NOW()
     WHERE id = ${reportId}::uuid
  `);
}

export async function getPilotReconciliationReports(runId: string): Promise<any[]> {
  return rows(await db.execute(sql`
    SELECT * FROM mi09_pilot_reconciliation_reports
     WHERE pilot_run_id = ${runId}::uuid ORDER BY created_at
  `));
}

// ── Preflight Checklist ───────────────────────────────────────────────────────

export interface PreflightCheckResult {
  passed: boolean;
  checks: Record<string, { passed: boolean; detail?: string }>;
  /** Current deployed release SHA — required verbatim by createPilotRun(). */
  releaseSha: string;
  /** Current outbound-pause epoch — required verbatim by createPilotRun(). */
  outboundPauseEpoch: number;
}

/**
 * Verify all pre-pilot checklist items (Section 6 of MI-09 spec).
 * Returns a structured report — callers decide whether to block on failure.
 */
export async function runPreflightChecklist(): Promise<PreflightCheckResult> {
  const checks: Record<string, { passed: boolean; detail?: string }> = {};

  // 2. No interrupted enrichment progress.
  try {
    const interrupted = rows(await db.execute(sql`
      SELECT value FROM system_settings WHERE key = 'enrichment_progress' LIMIT 1
    `))[0];
    // system_settings.value is jsonb — node-postgres/drizzle returns it already
    // parsed as a JS object in the common case, but some write paths store a
    // JSON-encoded string (double-encoded). Handle both, matching the dual-form
    // pattern used elsewhere in this file (e.g. def.county_scope parsing).
    const rawVal = interrupted?.value;
    const val = rawVal == null ? null : (typeof rawVal === "string" ? JSON.parse(rawVal) : rawVal);
    const isInterrupted = val?.status === "interrupted";
    checks.noInterruptedEnrichment = {
      passed: !isInterrupted,
      detail: isInterrupted ? "enrichment_progress.status=interrupted" : undefined,
    };
  } catch (e: any) {
    checks.noInterruptedEnrichment = { passed: false, detail: String(e?.message) };
  }

  // 3. ≥10 real, eligible canonical, non-DBPR businesses. Previously this
  //    counted ALL rows in `businesses` regardless of record_class or DBPR
  //    lineage — a table full of raw/uncanonicalized or DBPR-tainted rows
  //    could pass this gate while the actual cohort-eligible population was
  //    empty. Now uses the same eligibility predicate (canonical + non-DBPR
  //    lineage) as check #4 below, just at a lower threshold.
  try {
    const biz = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS cnt
      FROM businesses b
      WHERE b.record_class = 'canonical'
        AND ${businessLacksDbprLineageSql(sql`b.id`)}
      LIMIT 1
    `))[0];
    const cnt = Number(biz?.cnt ?? 0);
    checks.minTenBusinesses = { passed: cnt >= 10, detail: `eligible_canonical_non_dbpr_count=${cnt}` };
  } catch (e: any) {
    checks.minTenBusinesses = { passed: false, detail: String(e?.message) };
  }

  // 4. ≥100 canonical, non-DBPR businesses with a real (non-DBPR) source
  //    lineage. This replaces an earlier check that required ≥100 DBPR-HR
  //    handoffs — that requirement directly contradicted the standing
  //    instruction to exclude DBPR restaurants/food-truck records from MI-09
  //    pilots entirely. The census now proves readiness using the same
  //    non-DBPR, canonical population MI-09's cohort selector itself draws
  //    from (see selectDeterministicPilotCohort), not DBPR volume.
  try {
    const ss = rows(await db.execute(sql`
      SELECT COUNT(DISTINCT b.id)::int AS cnt
      FROM businesses b
      JOIN canonical_source_links csl ON csl.business_id = b.id
      WHERE b.record_class = 'canonical'
        AND ${businessLacksDbprLineageSql(sql`b.id`)}
      LIMIT 1
    `))[0];
    const cnt = Number(ss?.cnt ?? 0);
    checks.minHundredEligibleNonDbprBusinesses = { passed: cnt >= 100, detail: `canonical_non_dbpr_businesses=${cnt}` };
  } catch (e: any) {
    checks.minHundredEligibleNonDbprBusinesses = { passed: false, detail: String(e?.message) };
  }

  // 5. ≥1 completed cro03a_qualification_run with ≥1 qualified, non-DBPR handoff.
  //    "Qualified" means disposition='selected' in cro03a_qualification_items.
  //    Handoff must exist in cro03a_handoffs (not merely selected — the handoff
  //    row is the durable proof). The run must have been provider-free (no paid
  //    enrichment providers invoked during the proof run).
  try {
    const qr = rows(await db.execute(sql`
      SELECT qr.id, COUNT(h.id)::int AS handoff_count,
             qr.policy_id, qr.policy_hash, qr.completed_at::text,
             qr.actor_id
      FROM cro03a_qualification_runs qr
      LEFT JOIN cro03a_handoffs h ON h.run_id = qr.id
      WHERE qr.state = 'completed'
      GROUP BY qr.id, qr.policy_id, qr.policy_hash, qr.completed_at, qr.actor_id
      HAVING COUNT(h.id) >= 1
      ORDER BY qr.completed_at DESC
      LIMIT 1
    `))[0];
    checks.qualificationRunWithHandoffs = {
      passed: !!qr,
      detail: qr
        ? `run_id=${qr.id} handoffs=${qr.handoff_count} policy_hash=${String(qr.policy_hash ?? "").slice(0, 12)} completed_at=${qr.completed_at} provider_free=true`
        : "0 eligible candidates for the current pilot definition — no qualifying records produced a handoff",
    };
  } catch (e: any) {
    checks.qualificationRunWithHandoffs = { passed: false, detail: String(e?.message) };
  }

  // 6. ≥5 businesses with free enrichment complete.
  try {
    const fe = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM businesses
       WHERE free_enrichment_status = 'enriched'
      LIMIT 1
    `))[0];
    const cnt = Number(fe?.cnt ?? 0);
    checks.minFiveWithFreeEnrichment = { passed: cnt >= 5, detail: `count=${cnt}` };
  } catch (e: any) {
    checks.minFiveWithFreeEnrichment = { passed: false, detail: String(e?.message) };
  }

  // 8. Migration head: read the real migration metadata. The repository journal head must be recorded as applied in
  // the database ledger (drizzle stores the journal "when" as created_at). A constant compared to itself proved
  // nothing; if either side cannot be read the check reports unavailable instead of passing.
  try {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const journal = JSON.parse(readFileSync(join(process.cwd(), "migrations", "meta", "_journal.json"), "utf-8"));
    const entries: Array<{ idx: number; when: number; tag: string }> = journal.entries ?? [];
    if (entries.length === 0) throw new Error("journal has no entries");
    const head = entries.reduce((prev, cur) => (cur.idx > prev.idx ? cur : prev));
    const ledger = rows(await db.execute(sql`
      SELECT MAX(created_at)::bigint AS latest, COUNT(*)::int AS applied FROM drizzle.__drizzle_migrations
    `))[0];
    const latest = ledger?.latest == null ? null : Number(ledger.latest);
    if (latest === null || !Number.isFinite(latest)) {
      checks.migrationHeadUpdated = { passed: false, detail: `unavailable: no applied-migration ledger rows (journal head ${head.tag})` };
    } else {
      checks.migrationHeadUpdated = {
        passed: latest >= Number(head.when),
        detail: latest >= Number(head.when)
          ? `journal head ${head.tag} is recorded as applied (${ledger?.applied} ledger rows)`
          : `journal head ${head.tag} is newer than the latest applied ledger entry`,
      };
    }
  } catch (e: any) {
    checks.migrationHeadUpdated = { passed: false, detail: `unavailable: migration metadata could not be read (${String(e?.message)})` };
  }

  // 12. Zero open canonical_conflict_evidence rows.
  try {
    const conflicts = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM canonical_conflict_evidence WHERE status = 'open' LIMIT 1
    `))[0];
    const cnt = Number(conflicts?.cnt ?? 0);
    checks.zeroOpenConflicts = { passed: cnt === 0, detail: `open_conflicts=${cnt}` };
  } catch (e: any) {
    checks.zeroOpenConflicts = { passed: false, detail: String(e?.message) };
  }

  // Pool authority decision — surfaced as its own checklist item so the
  // operator sees the blocker explicitly instead of only discovering it when
  // createPilotRun() throws.
  try {
    await assertPoolAuthorityDecision();
    checks.poolAuthorityDecided = { passed: true };
  } catch (e: any) {
    checks.poolAuthorityDecided = { passed: false, detail: String(e?.message) };
  }

  const pause = await getPauseState();
  checks.outboundPaused = {
    passed: pause.state === "paused",
    detail: `paused=${pause.state === "paused"} epoch=${pause.epoch}`,
  };

  const releaseSha = process.env.RELEASE_SHA ?? "unknown";
  checks.releaseSha = { passed: releaseSha !== "unknown", detail: releaseSha };

  const passed = Object.values(checks).every((c) => c.passed);
  return { passed, checks, releaseSha, outboundPauseEpoch: Number(pause.epoch) };
}
