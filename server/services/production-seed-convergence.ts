/**
 * Production seed convergence — the single cross-cutting authority for
 * production-required rows that a migration's imperative INSERT/UPDATE seeds
 * but that Replit Publish's schema-only sync never executes.
 *
 * Background (Task #1750): a production census found that recent migrations
 * across unrelated systems (CRO-02, CRO-03, CRO-03A, CR-04, CR-06, inbound
 * effect orchestration) correctly created their tables via Publish schema
 * sync, but every migration-embedded seed/backfill INSERT silently never ran,
 * because the app's Drizzle migration runner is deliberately never pointed at
 * production (see `.agents/memory/production-schema-ownership.md`). Only
 * `commercial_purpose_policies` was safe, because it already had a dedicated
 * convergence initializer (`cro02-purpose-policy-initializer.ts`).
 *
 * This module is the ONE owner for that class of gap. It does not replace or
 * replay migrations — it registers one idempotent, insert-only convergence
 * function per production-required seed/backfill target, runs them in a
 * defined order at startup, and records a deterministic per-target outcome.
 * Two of the nine targets below are still implemented in their own dedicated
 * files (`cro02-purpose-policy-initializer.ts`, `cro03a-policy-initializer.ts`)
 * because they pre-date this module and already match its guarantees; this
 * module is still their sole caller and reporting owner.
 *
 * Every target function:
 *  - never runs schema DDL and never touches the Drizzle migration journal,
 *  - fails closed (throws) if it finds a row that conflicts with the
 *    canonical content, rather than silently overwriting it,
 *  - is idempotent under concurrent boots via a per-target Postgres advisory
 *    lock plus `ON CONFLICT DO NOTHING` on the real unique/composite key.
 * Most targets insert missing rows; incident corrections below use explicit
 * narrow guards and audit copies before altering a known bad projection.
 */
import { sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { initializeCro02PurposePolicies } from "./cro02-purpose-policy-initializer";
import { initializeCro03aPolicy, CRO03A_SEED_POLICY_KEY, CRO03A_SEED_POLICY_VERSION, CRO03A_SEED_POLICY_HASH } from "./cro03a-policy-initializer";
import { CRO02_POLICY_VERSION, CRO02_PURPOSE_POLICY_DOCUMENTS } from "./commercial-resolution";
import {
  MI09_PRICING_SEED_TABLE,
  MI09_PRICING_CAPTURED_BY,
  MI09_PRICING_ARTIFACT_VERSION,
  MI09_PRICING_CURRENCY,
  MI09_PRICING_ACCOUNT_BALANCE_UNITS,
} from "./cro03/mi09-pricing-seed-data";
import { reuseOrCreatePricingArtifact, createPricingScheduleSnapshot, getPoolAuthorityDecision, setPoolAuthorityDecision } from "./mi09-pilot-authority";
import { createCro08aScheduleDefinition } from "./cro08a/schedule-authority";

const MI09_PRICING_SEED_KEY_VALUES: string[][] = MI09_PRICING_SEED_TABLE.map((r) => [r.providerKey, String(MI09_PRICING_ARTIFACT_VERSION)]);

// The 8 canonical (purpose, policy_version) key pairs this module's
// cro02_purpose_policies target is coded to converge — see
// cro02-purpose-policy-initializer.ts. A future migration seeding a NEW
// purpose or bumping policy_version for commercial_purpose_policies needs a
// corresponding update to CRO02_PURPOSE_POLICY_DOCUMENTS/CRO02_POLICY_VERSION
// (which this list derives from) or it will fail the seed-registration CI
// check rather than silently landing unconverged.
const CRO02_SEED_KEY_VALUES: string[][] = Object.keys(CRO02_PURPOSE_POLICY_DOCUMENTS).map((purpose) => [purpose, String(CRO02_POLICY_VERSION)]);

const rows = (result: unknown) => ((result as any)?.rows ?? []) as any[];
type Tx = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

// jsonb round-trips do not guarantee the original key insertion order, so any
// content-equality check against a canonical document must compare by value,
// not by raw JSON.stringify() text.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Classification recorded per target (Task #1750 done-criteria #2):
 *  - schema_required_bootstrap: a singleton/control row the app cannot run
 *    correctly without (e.g. commercial_shadow_controls).
 *  - immutable_revision_seed: a frozen policy/recipe document seeded once and
 *    never mutated afterward.
 *  - historical_backfill: a derived/cache row that a trigger or write path
 *    maintains going forward, but that pre-existing source rows never
 *    produced because the seeding migration never executed in production.
 */
export type SeedClassification =
  | "schema_required_bootstrap"
  | "immutable_revision_seed"
  | "historical_backfill";

export type SeedOutcome =
  | "already_present"
  | "inserted"
  | "backfilled"
  | "conflicted"
  | "blocked"
  | "unexpected";

export interface SeedTargetResult {
  id: string;
  classification: SeedClassification;
  tables: string[];
  outcome: SeedOutcome;
  detail: string;
}

export interface SeedConvergenceReport {
  runAt: string;
  ok: boolean;
  results: SeedTargetResult[];
}

/**
 * Registered natural-key identity for an `immutable_revision_seed` target
 * (Task #1750 code-review follow-up): registering a table alone is not
 * granular enough — a later migration could insert a NEW version/key row
 * into an already-registered table (e.g. cr04_qualification_policies
 * version=2) that this service's hardcoded converge function has no idea
 * exists and will never create or validate. `seedKeys` pins the exact
 * key-column values this module's converge function actually knows how to
 * produce/verify, so scripts/check-migration-seed-registration.ts can
 * detect when a migration's literal INSERT values fall outside that set and
 * fail the build until a human adds real handling for the new key.
 */
export interface SeedKeyRegistration {
  columns: string[];
  values: string[][];
}

async function assertColumns(tx: Tx, table: string, expected: Record<string, string>): Promise<void> {
  const found = rows(
    await tx.execute(sql`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table}
    `),
  );
  if (found.length === 0) throw new Error(`SEED_CONVERGENCE_TABLE_MISSING:${table}`);
  const byName = new Map(found.map((r: any) => [r.column_name, r.data_type]));
  for (const [column, dataType] of Object.entries(expected)) {
    if (byName.get(column) !== dataType) throw new Error(`SEED_CONVERGENCE_TABLE_SHAPE_INVALID:${table}.${column}`);
  }
}

async function withLock<T>(lockKey: string, run: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 1900))`);
    return run(tx as unknown as Tx);
  });
}

// ── Target: commercial_shadow_controls singleton ────────────────────────────
// migrations/0166_cro02_shadow_graph.sql:
//   INSERT INTO commercial_shadow_controls(control_key) VALUES ('commercial') ON CONFLICT DO NOTHING;
async function convergeCommercialShadowControls(): Promise<SeedTargetResult> {
  const id = "commercial_shadow_controls";
  const tables = ["commercial_shadow_controls"];
  return withLock(`seed:${id}`, async (tx) => {
    await assertColumns(tx, "commercial_shadow_controls", { control_key: "text", mode: "text" });
    const before = rows(await tx.execute(sql`SELECT control_key FROM commercial_shadow_controls WHERE control_key = 'commercial'`))[0];
    if (before) return { id, classification: "schema_required_bootstrap", tables, outcome: "already_present", detail: "control row already exists" };
    await tx.execute(sql`INSERT INTO commercial_shadow_controls(control_key) VALUES ('commercial') ON CONFLICT DO NOTHING`);
    const after = rows(await tx.execute(sql`SELECT control_key FROM commercial_shadow_controls WHERE control_key = 'commercial'`))[0];
    if (!after) throw new Error("SEED_CONVERGENCE_VERIFY_FAILED:commercial_shadow_controls");
    return { id, classification: "schema_required_bootstrap", tables, outcome: "inserted", detail: "inserted default control_key='commercial' row" };
  });
}

// ── Target: paid provider control rows (Task #1971 corrective item 6) ──────
// migrations/0269_paid_provider_controls_all.sql inserts one explicit,
// disabled (enabled=FALSE, circuit_state='closed') provider_controls row per
// paid caller (serper, outscraper, openai, apollo, zerobounce) so every paid
// provider has a fail-closed control row from day one instead of relying on
// "no row found" being treated as disabled by every caller. Like every other
// migration-embedded seed, Replit Publish's schema-only sync never executes
// this INSERT in production, so without a convergence target production is
// silently missing all 5 rows. Insert-only, ON CONFLICT DO NOTHING on the
// existing (provider) unique key — never touches a row that already exists
// (e.g. one an operator has since enabled).
const PAID_PROVIDER_CONTROL_SEED_ROWS: { provider: string; capability: string }[] = [
  { provider: "serper", capability: "business_discovery" },
  { provider: "outscraper", capability: "business_discovery" },
  { provider: "openai", capability: "cro03_classification" },
  { provider: "apollo", capability: "contact_enrichment" },
  { provider: "zerobounce", capability: "email_validation" },
];

// Parameterized so scripts/test-paid-provider-controls-convergence.ts can
// exercise the exact same insert/verify logic against synthetic, FK-safe
// provider names — the 5 real providers below have live provider_observations
// (and other) FK dependents in every environment that has ever run a
// discovery/enrichment cycle, so a test cannot safely delete-and-restore
// them in a shared dev DB.
export async function convergeProviderControlRows(
  id: string,
  seedRows: { provider: string; capability: string }[],
): Promise<SeedTargetResult> {
  const tables = ["provider_controls"];
  return withLock(`seed:${id}`, async (tx) => {
    await assertColumns(tx, "provider_controls", { provider: "text", capability: "text", enabled: "boolean", circuit_state: "text" });
    const before = rows(await tx.execute(sql`
      SELECT provider FROM provider_controls
      WHERE provider = ANY(ARRAY[${sql.join(seedRows.map((r) => sql`${r.provider}`), sql`, `)}])
    `));
    const beforeSet = new Set(before.map((r: any) => String(r.provider)));
    const missing = seedRows.filter((r) => !beforeSet.has(r.provider));
    if (missing.length === 0) {
      return { id, classification: "schema_required_bootstrap", tables, outcome: "already_present", detail: `all ${seedRows.length} paid-provider control row(s) already exist` };
    }
    for (const row of missing) {
      await tx.execute(sql`
        INSERT INTO provider_controls
          (provider, capability, enabled, circuit_state, local_budget_units, reserved_units, consumed_units, version)
        VALUES (${row.provider}, ${row.capability}, FALSE, 'closed', NULL, 0, 0, 0)
        ON CONFLICT (provider) DO NOTHING
      `);
    }
    const after = rows(await tx.execute(sql`
      SELECT provider FROM provider_controls
      WHERE provider = ANY(ARRAY[${sql.join(seedRows.map((r) => sql`${r.provider}`), sql`, `)}])
    `));
    const afterSet = new Set(after.map((r: any) => String(r.provider)));
    const stillMissing = seedRows.filter((r) => !afterSet.has(r.provider));
    if (stillMissing.length > 0) {
      throw new Error(`SEED_CONVERGENCE_VERIFY_FAILED:${id}:${stillMissing.map((r) => r.provider).join(",")}`);
    }
    return { id, classification: "schema_required_bootstrap", tables, outcome: "inserted", detail: `inserted ${missing.length} missing disabled control row(s): ${missing.map((r) => r.provider).join(", ")}` };
  });
}

async function convergePaidProviderControls(): Promise<SeedTargetResult> {
  return convergeProviderControlRows("paid_provider_controls", PAID_PROVIDER_CONTROL_SEED_ROWS);
}

// migrations/0289_sfp2000_policy_and_lineage.sql seeds this immutable policy
// document and its active singleton pointer. Publish's schema sync creates
// the tables but does not guarantee the migration's INSERTs run, so the SFP
// validation path must converge the exact v1 document before recurring work
// can read it. Existing operator-selected policy pointers are preserved.
const SFP_OUTREACH_POLICY_V1 = {
  version: 1,
  documentHash: "f8f014ae6937e1d83dbc1d128af377eb59fe6b009bc37dd26578bff4ed2e94df",
  validationTtlDays: 30,
  acceptedOutcomes: ["valid"],
  retryableOutcomes: ["failed", "dns_indeterminate", "unknown"],
  roleInboxPolicy: { role_inbox_eligible_for_cold_b2b: true, named_or_unclassified_requires_review: true },
  consentTierPolicy: {
    cold_no_consent: "eligible_for_staging_review",
    warm_no_pewc: "eligible_for_staging_review",
    pewc_full_automation: "eligible_for_staging_review",
    opted_out: "ineligible",
    do_not_contact: "ineligible",
  },
  reasonCodes: [
    "zb_valid_role_inbox_eligible", "zb_valid_named_review_required", "zb_catch_all_review",
    "zb_invalid_not_deliverable", "zb_spamtrap_not_deliverable", "zb_abuse_not_deliverable",
    "zb_do_not_mail_not_deliverable", "zb_unknown_review_required", "zb_transport_failed_retryable",
    "policy_existing_relationship", "policy_suppressed", "policy_consent_ineligible",
    "policy_dbpr_excluded", "policy_stale_reused",
  ],
} as const;

async function convergeSfpOutreachPolicyV1(): Promise<SeedTargetResult> {
  const id = "sfp_outreach_policy_v1";
  const tables = ["sfp_outreach_policy_documents", "sfp_outreach_policy_control"];
  return withLock(`seed:${id}`, async (tx) => {
    await assertColumns(tx, "sfp_outreach_policy_documents", {
      version: "integer", document_hash: "text", validation_ttl_days: "integer",
      accepted_outcomes: "jsonb", retryable_outcomes: "jsonb", role_inbox_policy: "jsonb",
      consent_tier_policy: "jsonb", reason_codes: "jsonb", created_by: "text",
    });
    await assertColumns(tx, "sfp_outreach_policy_control", {
      singleton: "boolean", active_policy_id: "uuid", activated_by: "text",
    });

    const expectedJson = {
      accepted_outcomes: SFP_OUTREACH_POLICY_V1.acceptedOutcomes,
      retryable_outcomes: SFP_OUTREACH_POLICY_V1.retryableOutcomes,
      role_inbox_policy: SFP_OUTREACH_POLICY_V1.roleInboxPolicy,
      consent_tier_policy: SFP_OUTREACH_POLICY_V1.consentTierPolicy,
      reason_codes: SFP_OUTREACH_POLICY_V1.reasonCodes,
    };
    // Match the policy-before-document lock order used by staging, bridge and
    // independent-review commits. Existing rows are only verified, never
    // updated, so SHARE preserves the pin without waiting for every live
    // policy reader to finish during a rolling publication.
    const control = rows(await tx.execute(sql`
      SELECT active_policy_id FROM sfp_outreach_policy_control WHERE singleton = TRUE FOR SHARE
    `))[0];
    let document = rows(await tx.execute(sql`
      SELECT id, version, document_hash, validation_ttl_days, accepted_outcomes,
             retryable_outcomes, role_inbox_policy, consent_tier_policy, reason_codes
        FROM sfp_outreach_policy_documents WHERE version = 1 FOR SHARE
    `))[0];
    let insertedDocument = false;
    if (!document) {
      await tx.execute(sql`
        INSERT INTO sfp_outreach_policy_documents
          (version, document_hash, validation_ttl_days, accepted_outcomes, retryable_outcomes,
           role_inbox_policy, consent_tier_policy, reason_codes, created_by)
        VALUES (
          1, ${SFP_OUTREACH_POLICY_V1.documentHash}, 30,
          ${JSON.stringify(SFP_OUTREACH_POLICY_V1.acceptedOutcomes)}::jsonb,
          ${JSON.stringify(SFP_OUTREACH_POLICY_V1.retryableOutcomes)}::jsonb,
          ${JSON.stringify(SFP_OUTREACH_POLICY_V1.roleInboxPolicy)}::jsonb,
          ${JSON.stringify(SFP_OUTREACH_POLICY_V1.consentTierPolicy)}::jsonb,
          ${JSON.stringify(SFP_OUTREACH_POLICY_V1.reasonCodes)}::jsonb,
          'system:production-seed-convergence'
        ) ON CONFLICT (version) DO NOTHING
      `);
      insertedDocument = true;
      document = rows(await tx.execute(sql`
        SELECT id, version, document_hash, validation_ttl_days, accepted_outcomes,
               retryable_outcomes, role_inbox_policy, consent_tier_policy, reason_codes
          FROM sfp_outreach_policy_documents WHERE version = 1 FOR SHARE
      `))[0];
    }
    if (!document || Number(document.version) !== 1 ||
        document.document_hash !== SFP_OUTREACH_POLICY_V1.documentHash ||
        Number(document.validation_ttl_days) !== SFP_OUTREACH_POLICY_V1.validationTtlDays ||
        Object.entries(expectedJson).some(([key, value]) => stableStringify(document[key]) !== stableStringify(value))) {
      throw new Error("SEED_CONVERGENCE_CONFLICT:sfp_outreach_policy_v1:canonical_document_mismatch");
    }

    const invalidControl = rows(await tx.execute(sql`
      SELECT singleton FROM sfp_outreach_policy_control WHERE singleton IS DISTINCT FROM TRUE LIMIT 1
    `))[0];
    if (invalidControl) throw new Error("SEED_CONVERGENCE_CONFLICT:sfp_outreach_policy_v1:invalid_singleton_row");

    let insertedControl = false;
    if (!control) {
      await tx.execute(sql`
        INSERT INTO sfp_outreach_policy_control (singleton, active_policy_id, activated_by)
        VALUES (TRUE, ${String(document.id)}::uuid, 'system:production-seed-convergence')
        ON CONFLICT (singleton) DO NOTHING
      `);
      insertedControl = true;
      const verified = rows(await tx.execute(sql`
        SELECT active_policy_id FROM sfp_outreach_policy_control WHERE singleton = TRUE FOR SHARE
      `))[0];
      if (!verified) throw new Error("SEED_CONVERGENCE_VERIFY_FAILED:sfp_outreach_policy_v1:control");
    }
    const outcome = insertedDocument || insertedControl ? "inserted" : "already_present";
    return {
      id, classification: "immutable_revision_seed", tables, outcome,
      detail: `${insertedDocument ? "inserted canonical policy v1" : "policy v1 already present"}; ` +
        `${insertedControl ? "installed default active pointer" : "preserved existing active policy pointer"}`,
    };
  });
}

// One-time correction from migration 0291: campaign staging must remain
// default-off. A durable marker keeps this narrow repair from overwriting a
// deliberate operator choice of batch size 10 on later boots.
async function convergeSfpCampaignStagingDefaultOff(): Promise<SeedTargetResult> {
  const id = "sfp_campaign_staging_default_off_v1";
  const tables = ["sfp_programs", "system_settings"];
  return withLock(`seed:${id}`, async (tx) => {
    await assertColumns(tx, "sfp_programs", { schedule_config: "jsonb" });
    await assertColumns(tx, "system_settings", { key: "text", value: "jsonb" });
    const markerKey = "production_seed_sfp_campaign_staging_default_off_v1";
    const marker = rows(await tx.execute(sql`SELECT key FROM system_settings WHERE key = ${markerKey} FOR UPDATE`))[0];
    if (marker) return { id, classification: "historical_backfill", tables, outcome: "already_present", detail: "one-time default-off correction already recorded" };

    const corrected = rows(await tx.execute(sql`
      UPDATE sfp_programs
         SET schedule_config = jsonb_set(COALESCE(schedule_config, '{}'::jsonb), '{campaignStaging}', '0'::jsonb, TRUE)
       WHERE schedule_config->>'campaignStaging' = '10'
       RETURNING id
    `));
    await tx.execute(sql`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES (${markerKey}, ${JSON.stringify({ version: 1, correctedPrograms: corrected.length })}::jsonb, NOW())
      ON CONFLICT (key) DO NOTHING
    `);
    return {
      id, classification: "historical_backfill", tables,
      outcome: corrected.length > 0 ? "backfilled" : "already_present",
      detail: `default-off correction recorded; changed ${corrected.length} legacy program row(s) with campaignStaging=10`,
    };
  });
}

// Safe repeatable legacy source-lineage completion for rows the migration
// could not mark because Publish may synchronize schema without replaying its
// data UPDATE. New staging writes always set source_kind explicitly.
async function convergeSfpStagingSourceLineage(): Promise<SeedTargetResult> {
  const id = "sfp_staging_source_lineage";
  const tables = ["sfp_campaign_staging_intents", "sfp_outreach_eligibility"];
  return withLock(`seed:${id}`, async (tx) => {
    await assertColumns(tx, "sfp_campaign_staging_intents", {
      candidate_id: "uuid", paid_candidate_evidence_id: "uuid", source_kind: "text",
    });
    await assertColumns(tx, "sfp_outreach_eligibility", {
      policy_version: "integer", candidate_id: "uuid", paid_candidate_evidence_id: "uuid",
      source_kind: "text", policy_document_id: "uuid", policy_document_hash: "text",
    });
    const intentUpdates = rows(await tx.execute(sql`
      UPDATE sfp_campaign_staging_intents
         SET source_kind = 'free'
       WHERE source_kind IS NULL AND candidate_id IS NOT NULL AND paid_candidate_evidence_id IS NULL
       RETURNING id
    `));
    const eligibilityUpdates = rows(await tx.execute(sql`
      UPDATE sfp_outreach_eligibility e
         SET source_kind = 'free', policy_document_id = pd.id, policy_document_hash = pd.document_hash
        FROM sfp_outreach_policy_documents pd
       WHERE pd.version = 1 AND e.policy_version = 1 AND e.candidate_id IS NOT NULL
         AND e.paid_candidate_evidence_id IS NULL AND e.source_kind IS NULL
      RETURNING e.id
    `));
    return {
      id, classification: "historical_backfill", tables,
      outcome: intentUpdates.length + eligibilityUpdates.length > 0 ? "backfilled" : "already_present",
      detail: `marked ${intentUpdates.length} legacy free-source intent(s) and attached policy v1 lineage to ${eligibilityUpdates.length} provable legacy eligibility decision(s)`,
    };
  });
}

// ── Target: SFP business #9555 identity-quarantine repair ──────────────────
// migrations/0304_sfp_identity_quarantine.sql. Like every other
// migration-embedded write, Replit Publish's schema-only sync creates the two
// new tables but never runs this migration's INSERT/UPDATE statements in
// production. This is not a config seed a runtime path depends on being
// present in general — it is a one-time, tightly-scoped repair of a single
// known bad Serper match (business 9555, voided cohort
// 03b65bd0-cf98-427f-92d5-4a7a79705028) that must still land in production or
// the wrong domain/phone/free-candidate rows stay live there. Every predicate
// below is copied verbatim from the migration file so this function converges
// exactly the same rows, no broader match.
const SFP_9555_BUSINESS_ID = 9555;
const SFP_9555_SUSPECT_DOMAIN = "prolawnlandscaper.com";
const SFP_9555_VOIDED_COHORT_RUN_ID = "03b65bd0-cf98-427f-92d5-4a7a79705028";

export async function convergeSfpIdentityQuarantineBusiness9555(): Promise<SeedTargetResult> {
  const id = "sfp_identity_quarantine_business_9555";
  const tables = ["sfp_identity_quarantines", "sfp_discredited_paid_evidence", "businesses", "free_discovery_candidates"];
  return withLock(`seed:${id}`, async (tx) => {
    await assertColumns(tx, "sfp_identity_quarantines", { business_id: "integer", reason_code: "text", suspect_domain: "text", cleared_at: "timestamp with time zone" });
    await assertColumns(tx, "sfp_discredited_paid_evidence", { evidence_id: "uuid", business_id: "integer", reason_code: "text" });

    const quarantineBefore = rows(await tx.execute(sql`
      SELECT business_id, cleared_at FROM sfp_identity_quarantines WHERE business_id = ${SFP_9555_BUSINESS_ID}
    `))[0];
    if (quarantineBefore) {
      return { id, classification: "historical_backfill", tables, outcome: "already_present", detail: "quarantine row for business 9555 already exists; convergence does not re-run repairs" };
    }

    await tx.execute(sql`
      INSERT INTO sfp_identity_quarantines
        (business_id, reason_code, suspect_domain, source_cohort_run_id)
      SELECT b.id, 'SERPER_WRONG_GEOGRAPHY', ${SFP_9555_SUSPECT_DOMAIN}, r.id
        FROM businesses b
        JOIN sfp_cohort_members m ON m.business_id = b.id
        JOIN sfp_cohort_runs r ON r.id = m.cohort_run_id
       WHERE b.id = ${SFP_9555_BUSINESS_ID}
         AND LOWER(BTRIM(b.canonical_name)) LIKE 'prolawn & landscaping%'
         AND (
           LOWER(BTRIM(b.website_domain)) = ${SFP_9555_SUSPECT_DOMAIN}
           OR EXISTS (
             SELECT 1 FROM sfp_stage_items i
             JOIN sfp_stage_runs s ON s.id = i.stage_run_id
             JOIN provider_operations o ON o.id = i.provider_operation_id
             WHERE i.business_id = b.id AND i.provider = 'serper'
               AND s.cohort_run_id = r.id
               AND LOWER(o.sfp_result_data->>'domain') = ${SFP_9555_SUSPECT_DOMAIN}
           )
         )
         AND r.id = ${SFP_9555_VOIDED_COHORT_RUN_ID}::uuid
         AND r.cohort_state = 'voided' AND r.voided_at IS NOT NULL
      ON CONFLICT (business_id) DO NOTHING
    `);

    const quarantineAfter = rows(await tx.execute(sql`
      SELECT business_id FROM sfp_identity_quarantines WHERE business_id = ${SFP_9555_BUSINESS_ID}
    `))[0];
    if (!quarantineAfter) {
      // The guard predicate did not match (e.g. business/cohort state does
      // not look the way the incident report described). Do not fabricate a
      // quarantine row or run the dependent repairs — report the true state.
      return { id, classification: "historical_backfill", tables, outcome: "unexpected", detail: "guard predicate matched zero rows for business 9555 — no quarantine created, no repair applied" };
    }

    await tx.execute(sql`
      INSERT INTO sfp_discredited_paid_evidence (evidence_id, business_id, reason_code)
      SELECT e.id, e.business_id, 'SERPER_WRONG_GEOGRAPHY'
        FROM sfp_paid_candidate_evidence e
        JOIN sfp_stage_items i ON i.provider_operation_id = e.provider_operation_id
        JOIN sfp_stage_runs s ON s.id = i.stage_run_id
        JOIN sfp_identity_quarantines q ON q.business_id = e.business_id
       WHERE e.business_id = ${SFP_9555_BUSINESS_ID} AND e.provider = 'serper'
         AND s.cohort_run_id = ${SFP_9555_VOIDED_COHORT_RUN_ID}::uuid
      ON CONFLICT (evidence_id) DO NOTHING
    `);

    await tx.execute(sql`
      UPDATE businesses b
         SET website_domain = NULL,
             main_phone = CASE WHEN LEFT(RIGHT(REGEXP_REPLACE(COALESCE(b.main_phone, ''), '[^0-9]', '', 'g'), 10), 3) = '518'
                               THEN NULL ELSE b.main_phone END,
             free_enrichment_status = NULL,
             free_enrichment_completed_at = NULL,
             updated_at = NOW()
       WHERE b.id = ${SFP_9555_BUSINESS_ID} AND LOWER(BTRIM(b.website_domain)) = ${SFP_9555_SUSPECT_DOMAIN}
         AND EXISTS (SELECT 1 FROM sfp_identity_quarantines q
                      WHERE q.business_id = b.id AND q.cleared_at IS NULL)
    `);

    await tx.execute(sql`
      UPDATE free_discovery_candidates f
         SET disposition = 'rejected'
       WHERE f.business_id = ${SFP_9555_BUSINESS_ID} AND LOWER(BTRIM(f.domain)) = ${SFP_9555_SUSPECT_DOMAIN}
         AND f.disposition IN ('staged', 'validation_admitted')
         AND EXISTS (SELECT 1 FROM sfp_identity_quarantines q
                      WHERE q.business_id = f.business_id AND q.cleared_at IS NULL)
    `);

    return { id, classification: "historical_backfill", tables, outcome: "backfilled", detail: "inserted quarantine + discredited-evidence rows and nulled the wrong domain/518-phone/free-candidate rows for business 9555" };
  });
}

// migrations/0305_sfp_wrong_site_derived_evidence.sql. The 0304 repair
// removed the wrong domain, 518 phone and free candidates, but the same crawl
// left a visible free summary and a processor signal in the business record.
// Publish syncs the archive tables without executing migration DML, so mirror
// the exact guarded archive-and-removal here. The immutable paid observations
// and historical source events are left intact under their rejection gates.
export async function convergeSfpWrongSiteDerivedEvidence9555(): Promise<SeedTargetResult> {
  const id = "sfp_wrong_site_derived_evidence_9555";
  const tables = ["sfp_discredited_processor_signals", "sfp_discredited_free_enrichment_summaries", "processor_signals", "businesses"];
  return withLock(`seed:${id}`, async (tx) => {
    await assertColumns(tx, "sfp_discredited_processor_signals", { signal_id: "integer", business_id: "integer", original_row: "jsonb", reason_code: "text" });
    await assertColumns(tx, "sfp_discredited_free_enrichment_summaries", { business_id: "integer", original_evidence: "jsonb", reason_code: "text" });

    // Disposable and development databases need not contain this production
    // incident. An unrelated business that happens to have id 9555 must not
    // become a required repair target.
    const incident = rows(await tx.execute(sql`
      SELECT id FROM businesses WHERE id = ${SFP_9555_BUSINESS_ID}
        AND LOWER(BTRIM(canonical_name)) LIKE 'prolawn & landscaping%'
    `))[0];
    if (!incident) return { id, classification: "historical_backfill", tables, outcome: "already_present", detail: "production incident business absent" };

    const archived = rows(await tx.execute(sql`
      SELECT EXISTS(SELECT 1 FROM sfp_discredited_processor_signals
          WHERE signal_id = 1548 AND business_id = ${SFP_9555_BUSINESS_ID}
            AND reason_code = 'SERPER_WRONG_GEOGRAPHY'
            AND original_row->>'vendor_name' = 'Squarespace Commerce'
            AND original_row->>'detection_method' = 'script') AS signal_archived,
        EXISTS(SELECT 1 FROM sfp_discredited_free_enrichment_summaries
          WHERE business_id = ${SFP_9555_BUSINESS_ID}
            AND reason_code = 'SERPER_WRONG_GEOGRAPHY'
            AND original_evidence->>'collectedAt' = '2026-09-28T01:06:23.035Z') AS summary_archived,
        EXISTS(SELECT 1 FROM processor_signals
          WHERE id = 1548 AND business_id = ${SFP_9555_BUSINESS_ID}) AS signal_live,
        (SELECT free_enrichment_evidence IS NULL FROM businesses
          WHERE id = ${SFP_9555_BUSINESS_ID}) AS summary_cleared
    `))[0];
    if (archived.signal_archived && archived.summary_archived &&
        !archived.signal_live && archived.summary_cleared) {
      return { id, classification: "historical_backfill", tables, outcome: "already_present", detail: "wrong-site signal and summary already archived and absent from live business" };
    }

    const guard = rows(await tx.execute(sql`
      SELECT q.business_id FROM sfp_identity_quarantines q
      JOIN businesses b ON b.id = q.business_id
      WHERE q.business_id = ${SFP_9555_BUSINESS_ID}
        AND q.cleared_at IS NULL AND q.reason_code = 'SERPER_WRONG_GEOGRAPHY'
        AND q.suspect_domain = ${SFP_9555_SUSPECT_DOMAIN}
        AND b.website_domain IS NULL
      FOR UPDATE OF q, b
    `))[0];
    if (!guard) return { id, classification: "historical_backfill", tables, outcome: "unexpected", detail: "active quarantine or cleared wrong-domain guard missing; no derived evidence changed" };

    await tx.execute(sql`
      INSERT INTO sfp_discredited_processor_signals (signal_id, business_id, original_row, reason_code)
      SELECT p.id, p.business_id, to_jsonb(p), 'SERPER_WRONG_GEOGRAPHY'
        FROM processor_signals p
       WHERE p.id = 1548 AND p.business_id = ${SFP_9555_BUSINESS_ID}
         AND p.signal_type = 'ecommerce_platform'
         AND p.vendor_name = 'Squarespace Commerce' AND p.detection_method = 'script'
         AND p.evidence = 'Script source: //assets.squarespace.com/@sqs/polyfiller/1.6/legacy.js'
      ON CONFLICT (signal_id) DO NOTHING
    `);
    await tx.execute(sql`
      DELETE FROM processor_signals p USING sfp_discredited_processor_signals d
       WHERE p.id = 1548 AND p.id = d.signal_id AND p.business_id = d.business_id
         AND to_jsonb(p) = d.original_row
    `);

    await tx.execute(sql`
      INSERT INTO sfp_discredited_free_enrichment_summaries (business_id, original_evidence, reason_code)
      SELECT b.id, b.free_enrichment_evidence, 'SERPER_WRONG_GEOGRAPHY'
        FROM businesses b
       WHERE b.id = ${SFP_9555_BUSINESS_ID} AND b.website_domain IS NULL
         AND b.free_enrichment_evidence->>'collectedAt' = '2026-09-28T01:06:23.035Z'
         AND b.free_enrichment_evidence->>'contactPageEmailCount' = '2'
         AND b.free_enrichment_evidence->'processorVendors' @> '["Squarespace Commerce"]'::jsonb
      ON CONFLICT (business_id) DO NOTHING
    `);
    await tx.execute(sql`
      UPDATE businesses b SET free_enrichment_evidence = NULL, updated_at = NOW()
        FROM sfp_discredited_free_enrichment_summaries d
       WHERE b.id = ${SFP_9555_BUSINESS_ID} AND b.id = d.business_id
         AND b.free_enrichment_evidence = d.original_evidence
    `);

    const state = rows(await tx.execute(sql`
      SELECT
        (SELECT count(*)::int FROM sfp_discredited_processor_signals
          WHERE signal_id = 1548 AND business_id = ${SFP_9555_BUSINESS_ID}
            AND reason_code = 'SERPER_WRONG_GEOGRAPHY'
            AND original_row->>'vendor_name' = 'Squarespace Commerce'
            AND original_row->>'detection_method' = 'script') AS archived_signals,
        (SELECT count(*)::int FROM processor_signals
          WHERE id = 1548 AND business_id = ${SFP_9555_BUSINESS_ID}) AS live_signals,
        (SELECT count(*)::int FROM sfp_discredited_free_enrichment_summaries
          WHERE business_id = ${SFP_9555_BUSINESS_ID}
            AND reason_code = 'SERPER_WRONG_GEOGRAPHY'
            AND original_evidence->>'collectedAt' = '2026-09-28T01:06:23.035Z') AS archived_summaries,
        (SELECT free_enrichment_evidence IS NULL FROM businesses
          WHERE id = ${SFP_9555_BUSINESS_ID}) AS summary_cleared
    `))[0];
    if (Number(state?.archived_signals) !== 1 || Number(state?.live_signals) !== 0 ||
        Number(state?.archived_summaries) !== 1 || state?.summary_cleared !== true) {
      // Roll back the entire archive-and-removal transaction on drift.
      throw new Error(`SFP_WRONG_SITE_DERIVED_EVIDENCE_INCOMPLETE:${JSON.stringify(state)}`);
    }
    return { id, classification: "historical_backfill", tables, outcome: "backfilled",
      detail: "exactly one wrong-site processor signal and free summary archived and absent from live business 9555" };
  });
}

// ── Target: commercial graph revision backfill ──────────────────────────────
// commercial_subject_revisions / commercial_membership_revisions are
// otherwise maintained forward-only by the cro02_bump_graph_membership()
// trigger (migrations/0169, 0173). Rows that existed before that trigger ever
// ran against production have no revision row at all. This mirrors the
// trigger's own per-source-table mapping exactly, using ON CONFLICT DO
// NOTHING so a row a live trigger has already bumped is never touched.
async function convergeCommercialGraphRevisions(): Promise<SeedTargetResult> {
  const id = "commercial_graph_revisions_backfill";
  const tables = ["commercial_subject_revisions", "commercial_membership_revisions"];
  return withLock(`seed:${id}`, async (tx) => {
    await assertColumns(tx, "commercial_subject_revisions", { subject_type: "text", subject_id: "integer", revision: "integer" });
    await assertColumns(tx, "commercial_membership_revisions", { edge_type: "text", revision: "integer" });

    const subjectsResult = await tx.execute(sql`
      INSERT INTO commercial_subject_revisions (subject_type, subject_id, revision, authority_version, updated_at)
      SELECT 'contact', contact_id, 1, 1, now() FROM contact_business_link_decisions
      UNION ALL SELECT 'business', business_id, 1, 1, now() FROM contact_business_link_decisions WHERE business_id IS NOT NULL
      UNION ALL SELECT 'company', company_id, 1, 1, now() FROM legacy_company_mapping_decisions
      UNION ALL SELECT 'business', business_id, 1, 1, now() FROM legacy_company_mapping_decisions WHERE business_id IS NOT NULL
      UNION ALL SELECT 'contact', contact_id, 1, 1, now() FROM commercial_relationship_reviews
      UNION ALL SELECT 'business', business_id, 1, 1, now() FROM commercial_relationship_reviews WHERE business_id IS NOT NULL
      UNION ALL SELECT 'contact', contact_id, 1, 1, now() FROM contact_identity_observations
      UNION ALL SELECT 'contact', deprecated_contact_id, 1, 1, now() FROM contact_merge_redirects
      UNION ALL SELECT 'contact', survivor_contact_id, 1, 1, now() FROM contact_merge_redirects
      ON CONFLICT (subject_type, subject_id) DO NOTHING
    `);

    const membershipResult = await tx.execute(sql`
      INSERT INTO commercial_membership_revisions
        (edge_type, left_subject_type, left_subject_id, right_subject_type, right_subject_id, revision, authority_version, updated_at)
      SELECT 'contact_business', 'contact', contact_id,
             CASE WHEN business_id IS NULL THEN 'contact' ELSE 'business' END,
             COALESCE(business_id, contact_id), 1, 1, now()
        FROM contact_business_link_decisions
      UNION ALL
      SELECT 'legacy_company_business', 'company', company_id,
             CASE WHEN business_id IS NULL THEN 'company' ELSE 'business' END,
             COALESCE(business_id, company_id), 1, 1, now()
        FROM legacy_company_mapping_decisions
      UNION ALL
      SELECT 'relationship', 'contact', contact_id,
             CASE WHEN business_id IS NULL THEN 'contact' ELSE 'business' END,
             COALESCE(business_id, contact_id), 1, 1, now()
        FROM commercial_relationship_reviews
      UNION ALL
      SELECT 'identity', 'contact', contact_id, 'contact', contact_id, 1, 1, now()
        FROM contact_identity_observations
      UNION ALL
      SELECT 'contact_redirect', 'contact', deprecated_contact_id, 'contact', survivor_contact_id, 1, 1, now()
        FROM contact_merge_redirects
      ON CONFLICT (edge_type, left_subject_type, left_subject_id, right_subject_type, right_subject_id) DO NOTHING
    `);

    const subjectsInserted = (subjectsResult as any)?.rowCount ?? 0;
    const membershipsInserted = (membershipResult as any)?.rowCount ?? 0;
    return {
      id, classification: "historical_backfill", tables,
      outcome: subjectsInserted + membershipsInserted > 0 ? "backfilled" : "already_present",
      detail: `inserted ${subjectsInserted} subject revision row(s), ${membershipsInserted} membership revision row(s)`,
    };
  });
}

// ── Target: cro03_staging_recipes frozen v1 recipe ──────────────────────────
// migrations/0177_cro03_source_staging_evidence.sql
const CRO03_STAGING_RECIPE_KEY = "south_florida_staging";
const CRO03_STAGING_RECIPE_VERSION = 1;
const CRO03_STAGING_RECIPE_HASH = "acb953300783e95cd61c8ad18f068d13233a587d99fb4dae4d9999982b8a38cc";
async function convergeCro03StagingRecipes(): Promise<SeedTargetResult> {
  const id = "cro03_staging_recipes";
  const tables = ["cro03_staging_recipes"];
  return withLock(`seed:${id}`, async (tx) => {
    await assertColumns(tx, "cro03_staging_recipes", { recipe_key: "text", version: "integer", recipe_hash: "text", status: "text" });
    const existing = rows(await tx.execute(sql`
      SELECT recipe_hash, status FROM cro03_staging_recipes
      WHERE recipe_key = ${CRO03_STAGING_RECIPE_KEY} AND version = ${CRO03_STAGING_RECIPE_VERSION}
    `))[0];
    if (existing) {
      if (String(existing.recipe_hash) !== CRO03_STAGING_RECIPE_HASH || existing.status !== "disabled") {
        throw new Error("SEED_CONVERGENCE_CONFLICT:cro03_staging_recipes");
      }
      return { id, classification: "immutable_revision_seed", tables, outcome: "already_present", detail: "canonical v1 recipe already present" };
    }
    await tx.execute(sql`
      INSERT INTO cro03_staging_recipes (
        recipe_key, version, geography_policy, fit_policy, provenance_policy,
        exclusion_policy, duplicate_policy, quarantine_policy, purpose_policy,
        actor_policy, route_policy, cost_policy, recipe_hash
      ) VALUES (
        ${CRO03_STAGING_RECIPE_KEY}, ${CRO03_STAGING_RECIPE_VERSION},
        '{"states":["FL"],"counties":["Miami-Dade","Broward","Palm Beach"],"mode":"allowlist"}'::jsonb,
        '{"mode":"evidence_only","minimumEvidence":1}'::jsonb,
        '{"requireObservation":true,"allowedSubjectTypes":["contact","prospect","sunbiz_entity","sdr_merchant","provider_csv_row","public_web"]}'::jsonb,
        '{"excludeDoNotContact":true,"excludeExistingCustomer":true}'::jsonb,
        '{"strategy":"hash_then_review","fields":["email","phone","website","registry_id"]}'::jsonb,
        '{"default":"quarantined","releaseRequires":"reviewed_disposition"}'::jsonb,
        '{"allowed":["provider_pre_spend","staging_review"],"default":"staging_review"}'::jsonb,
        '{"requireActor":true,"allowedActorTypes":["user","system","import"]}'::jsonb,
        '{"providers":[],"execution":"disabled","requiresFrozenEvidence":true}'::jsonb,
        '{"currency":"USD","maxAmountMicros":0,"providerSpendAllowed":false}'::jsonb,
        ${CRO03_STAGING_RECIPE_HASH}
      ) ON CONFLICT (recipe_key, version) DO NOTHING
    `);
    const verify = rows(await tx.execute(sql`
      SELECT recipe_hash FROM cro03_staging_recipes WHERE recipe_key = ${CRO03_STAGING_RECIPE_KEY} AND version = ${CRO03_STAGING_RECIPE_VERSION}
    `))[0];
    if (!verify || String(verify.recipe_hash) !== CRO03_STAGING_RECIPE_HASH) throw new Error("SEED_CONVERGENCE_VERIFY_FAILED:cro03_staging_recipes");
    return { id, classification: "immutable_revision_seed", tables, outcome: "inserted", detail: "inserted canonical v1 south_florida_staging recipe" };
  });
}

// ── Target: cr04_qualification_policies v1 ──────────────────────────────────
// migrations/0178_cr04_channel_cohort_authority.sql. cr04_channel_decisions
// has a NOT NULL FK to this table's version column, so any consumer already
// fails closed (FK violation) if the row is absent — this target only needs
// to converge the row itself.
const CR04_POLICY_DOCUMENT = { channels: ["email", "manual_call", "sms"], purpose: "marketing_outreach", failClosed: true };
async function convergeCr04QualificationPolicies(): Promise<SeedTargetResult> {
  const id = "cr04_qualification_policies";
  const tables = ["cr04_qualification_policies"];
  return withLock(`seed:${id}`, async (tx) => {
    await assertColumns(tx, "cr04_qualification_policies", { version: "integer", status: "text", document: "jsonb" });
    const existing = rows(await tx.execute(sql`
      SELECT status, decision_ttl_seconds, taxonomy_version, document FROM cr04_qualification_policies WHERE version = 1
    `))[0];
    if (existing) {
      const matches = existing.status === "active" && Number(existing.decision_ttl_seconds) === 900 &&
        existing.taxonomy_version === "cr04-reasons-v1" &&
        stableStringify(existing.document) === stableStringify(CR04_POLICY_DOCUMENT);
      if (!matches) throw new Error("SEED_CONVERGENCE_CONFLICT:cr04_qualification_policies");
      return { id, classification: "immutable_revision_seed", tables, outcome: "already_present", detail: "canonical v1 policy already present" };
    }
    await tx.execute(sql`
      INSERT INTO cr04_qualification_policies(version, status, decision_ttl_seconds, taxonomy_version, document)
      VALUES (1, 'active', 900, 'cr04-reasons-v1', ${JSON.stringify(CR04_POLICY_DOCUMENT)}::jsonb)
      ON CONFLICT (version) DO NOTHING
    `);
    const verify = rows(await tx.execute(sql`SELECT status FROM cr04_qualification_policies WHERE version = 1`))[0];
    if (!verify || verify.status !== "active") throw new Error("SEED_CONVERGENCE_VERIFY_FAILED:cr04_qualification_policies");
    return { id, classification: "immutable_revision_seed", tables, outcome: "inserted", detail: "inserted canonical v1 qualification policy" };
  });
}

// ── Target: cro03_provider_ledger reservation lineage repair ───────────────
// migrations/0175_cro03_frozen_subject_plans.sql + 0193 (idempotent repair of
// the same operation). Every pre-existing terminal ledger entry needs a
// synthetic reservation predecessor before the lineage trigger will accept
// any further write against it.
//
// cro03_ledger_immutable (installed by 0175/0193 via CREATE TRIGGER — not a
// Drizzle-managed object, so it is NOT part of Publish's schema.ts diff) is a
// BEFORE UPDATE OR DELETE guard that unconditionally rejects any UPDATE
// against this table, including the two repair UPDATEs below. The source
// migrations solve this by dropping the trigger immediately before the
// repair writes and recreating it immediately after, inside the same
// statement batch. Because this service is the only thing that ever runs
// this repair against production (the migration file itself never replays
// there), it must own that same drop/repair/recreate sequence itself — not
// assume the guard is already absent or already present.
const CRO03_LEDGER_IMMUTABLE_GUARD_FN_SQL = sql`
  CREATE OR REPLACE FUNCTION cro03_immutable_row_guard()
  RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql
`;

const CRO03_LEDGER_LINEAGE_GUARD_FN_SQL = sql`
  CREATE OR REPLACE FUNCTION cro03_validate_ledger_terminal_lineage()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    PERFORM 1 FROM cro03_provider_runs run
    JOIN provider_operations operation ON operation.id=NEW.provider_operation_id
     WHERE run.id=NEW.provider_run_id
       AND run.operation_id=NEW.provider_operation_id
       AND run.provider=NEW.provider
       AND operation.provider=NEW.provider
     FOR UPDATE OF run,operation;
    IF NOT FOUND THEN RAISE EXCEPTION 'CRO03_LEDGER_RUN_OPERATION_PROVIDER_MISMATCH'; END IF;
    IF NEW.event_type='terminal' AND NOT EXISTS (
      SELECT 1 FROM cro03_provider_ledger reservation
       WHERE reservation.id=NEW.reservation_entry_id
         AND reservation.event_type='reservation'
         AND reservation.provider_run_id=NEW.provider_run_id
         AND reservation.provider_operation_id IS NOT DISTINCT FROM NEW.provider_operation_id
         AND reservation.provider=NEW.provider
         AND reservation.units=NEW.units
         AND reservation.amount_micros=NEW.amount_micros
    ) THEN RAISE EXCEPTION 'CRO03_LEDGER_LINEAGE_MISMATCH'; END IF;
    RETURN NEW;
  END $$
`;

async function convergeCro03LedgerLineage(): Promise<SeedTargetResult> {
  const id = "cro03_provider_ledger_lineage_repair";
  const tables = ["cro03_provider_ledger"];
  return withLock(`seed:${id}`, async (tx) => {
    await assertColumns(tx, "cro03_provider_ledger", { event_type: "text", reservation_entry_id: "uuid", entry_key: "text" });
    // FOUR separate objects installed by 0175/0193 alongside this exact
    // repair can each block it once already active in production, because
    // none of them are Drizzle-managed (not in schema.ts, so Publish's
    // schema diff never touches them) and this service — not the migration
    // file — is the only thing that ever runs this repair there:
    //  1. cro03_ledger_immutable (BEFORE UPDATE OR DELETE) rejects the
    //     repair's own UPDATEs outright.
    //  2. cro03_ledger_lineage_guard (BEFORE INSERT OR UPDATE) rejects
    //     flipping a row to event_type='terminal' before its synthetic
    //     reservation sibling exists — an intermediate state the 3-step
    //     repair below necessarily passes through.
    //  3. cro03_ledger_one_reservation_per_run / ..._per_operation (unique
    //     partial indexes on event_type='reservation') reject inserting a
    //     new reservation sibling for a run while a legacy row for that
    //     same run still holds the schema-default event_type='reservation'
    //     — which is why the repair must flip the legacy row to 'terminal'
    //     BEFORE inserting its sibling, the opposite ordering constraint
    //     from guard #2 above.
    //  4. cro03_ledger_terminal_lineage_chk (CHECK) requires a 'terminal' row
    //     to already have reservation_entry_id set and a 'reservation' row
    //     to have disposition='outstanding' — the intermediate state right
    //     after step 1's UPDATE (event_type flipped to 'terminal',
    //     reservation_entry_id still NULL) violates it outright, before
    //     guard #2 even gets a chance to run.
    // No ordering of the 3-step repair can satisfy guards #2 and #4 while a
    // row is mid-transition AND simultaneously satisfy #3's uniqueness — so,
    // exactly like the original migration's own drop-repair-recreate
    // sequence, all four are dropped first and recreated only after the
    // repair verifiably holds. If any repair statement throws, the
    // surrounding transaction (withLock wraps this whole function in one
    // db.transaction) rolls back the drops too, so production is never left
    // without its guards.
    await tx.execute(CRO03_LEDGER_IMMUTABLE_GUARD_FN_SQL);
    await tx.execute(CRO03_LEDGER_LINEAGE_GUARD_FN_SQL);
    await tx.execute(sql`DROP TRIGGER IF EXISTS cro03_ledger_immutable ON cro03_provider_ledger`);
    await tx.execute(sql`DROP TRIGGER IF EXISTS cro03_ledger_lineage_guard ON cro03_provider_ledger`);
    await tx.execute(sql`DROP INDEX IF EXISTS cro03_ledger_one_reservation_per_run`);
    await tx.execute(sql`DROP INDEX IF EXISTS cro03_ledger_one_reservation_per_operation`);
    await tx.execute(sql`ALTER TABLE cro03_provider_ledger DROP CONSTRAINT IF EXISTS cro03_ledger_terminal_lineage_chk`);
    await tx.execute(sql`UPDATE cro03_provider_ledger SET event_type = 'terminal' WHERE disposition <> 'outstanding' AND event_type <> 'terminal'`);
    const inserted = await tx.execute(sql`
      INSERT INTO cro03_provider_ledger
        (provider_run_id, provider_operation_id, provider, entry_key, event_type, disposition, units, amount_micros)
      SELECT l.provider_run_id, l.provider_operation_id, l.provider, 'reserve:legacy:' || l.id,
             'reservation', 'outstanding', l.units, l.amount_micros
        FROM cro03_provider_ledger l
       WHERE l.event_type = 'terminal' AND l.reservation_entry_id IS NULL
      ON CONFLICT (entry_key) DO NOTHING
    `);
    await tx.execute(sql`
      UPDATE cro03_provider_ledger terminal SET reservation_entry_id = reservation.id
        FROM cro03_provider_ledger reservation
       WHERE terminal.event_type = 'terminal' AND terminal.reservation_entry_id IS NULL
         AND reservation.entry_key = 'reserve:legacy:' || terminal.id
    `);
    const remaining = rows(await tx.execute(sql`
      SELECT count(*)::int AS n FROM cro03_provider_ledger WHERE event_type = 'terminal' AND reservation_entry_id IS NULL
    `))[0];
    if (Number(remaining?.n ?? 0) > 0) throw new Error("SEED_CONVERGENCE_VERIFY_FAILED:cro03_provider_ledger_lineage_repair");
    const insertedCount = (inserted as any)?.rowCount ?? 0;
    // Recreate the check constraint before the triggers/indexes so the full
    // table is validated (a real scan, not just this run's rows) while the
    // triggers are still absent — a violation here fails loudly instead of
    // being masked by a trigger rejecting the ALTER's own internal scan.
    await tx.execute(sql`
      ALTER TABLE cro03_provider_ledger ADD CONSTRAINT cro03_ledger_terminal_lineage_chk CHECK (
        (event_type = 'reservation' AND reservation_entry_id IS NULL AND disposition = 'outstanding')
        OR (event_type = 'terminal' AND reservation_entry_id IS NOT NULL
            AND disposition IN ('consumed', 'released', 'refunded', 'ambiguous'))
      )
    `);
    await tx.execute(sql`
      CREATE TRIGGER cro03_ledger_immutable BEFORE UPDATE OR DELETE ON cro03_provider_ledger
        FOR EACH ROW EXECUTE FUNCTION cro03_immutable_row_guard()
    `);
    await tx.execute(sql`
      CREATE TRIGGER cro03_ledger_lineage_guard BEFORE INSERT OR UPDATE ON cro03_provider_ledger
        FOR EACH ROW EXECUTE FUNCTION cro03_validate_ledger_terminal_lineage()
    `);
    await tx.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS cro03_ledger_one_reservation_per_run
        ON cro03_provider_ledger(provider_run_id) WHERE event_type = 'reservation'
    `);
    await tx.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS cro03_ledger_one_reservation_per_operation
        ON cro03_provider_ledger(provider_operation_id) WHERE event_type = 'reservation' AND provider_operation_id IS NOT NULL
    `);
    return { id, classification: "historical_backfill", tables, outcome: insertedCount > 0 ? "backfilled" : "already_present", detail: `repaired ${insertedCount} legacy terminal ledger entr${insertedCount === 1 ? "y" : "ies"}` };
  });
}

// ── Target: cr06_campaign_gate_revisions backfill ───────────────────────────
// migrations/0185_cr06_history_and_feedback.sql — the append trigger only
// covers gates written after it exists; pre-existing gates need one revision
// row each.
async function convergeCr06CampaignGateRevisions(): Promise<SeedTargetResult> {
  const id = "cr06_campaign_gate_revisions_backfill";
  const tables = ["cr06_campaign_gate_revisions"];
  return withLock(`seed:${id}`, async (tx) => {
    await assertColumns(tx, "cr06_campaign_gate_revisions", { campaign_gate_id: "uuid", revision: "integer" });
    const inserted = await tx.execute(sql`
      INSERT INTO cr06_campaign_gate_revisions
        (campaign_gate_id, revision, state, actor_id, dependency_snapshot, opened_at, closed_at, created_at)
      SELECT id, revision, state, actor_id, dependency_snapshot, opened_at, closed_at, created_at
        FROM cr06_campaign_gates
      ON CONFLICT (campaign_gate_id, revision) DO NOTHING
    `);
    const insertedCount = (inserted as any)?.rowCount ?? 0;
    return { id, classification: "historical_backfill", tables, outcome: insertedCount > 0 ? "backfilled" : "already_present", detail: `inserted ${insertedCount} gate revision row(s)` };
  });
}

// ── Target: contacts record_class backfill ───────────────────────────────────
// All contacts created before the record_class column was added landed as
// 'unknown'. This target promotes them: known test/qa patterns → 'test',
// everything else → 'production'.  The check is: no 'unknown' rows remain.
// This differs from other targets in that it runs UPDATEs, not INSERTs —
// justified because (a) it is strictly a one-time historical backfill that
// cannot loop, (b) it only touches rows whose current class is 'unknown',
// and (c) subsequent startups are no-ops (zero unknown rows → rowCount=0).
export async function convergeContactRecordClassBackfill(): Promise<SeedTargetResult> {
  const id = "contact_record_class_backfill";
  const tables = ["contacts"];
  return withLock(`seed:${id}`, async (tx) => {
    // record_class is a Postgres enum — information_schema reports it as
    // 'USER-DEFINED' but the exact udt_name varies by DB; skip assertColumns
    // and instead confirm the column exists via a direct catalog query.
    const colCheck = rows(await tx.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'contacts' AND column_name = 'record_class'
    `));
    if (colCheck.length === 0) throw new Error("SEED_CONVERGENCE_TABLE_SHAPE_INVALID:contacts.record_class");

    // This UPDATE scans the full contacts table — disable the pool's 30-second
    // statement_timeout for this transaction only.
    await tx.execute(sql`SET LOCAL statement_timeout = '0'`);

    // Step 1 — promote known test/qa contacts.
    const TEST_COND = sql`
      email ILIKE '%@test.invalid'
      OR email ILIKE '%@test.internal'
      OR email ILIKE '%@libertybancard.test'
      OR email ILIKE '%@example.test'
      OR email ILIKE 'wh-test-%'
      OR email ILIKE 'ghl-deal-test-%'
      OR email ILIKE 'qa-release-%'
      OR email ILIKE 'qa-appt-%'
      OR email ILIKE 'no-op-%'
      OR email ILIKE 'test-ca-%'
      OR email ILIKE 'liberty-data-%@test.internal'
      OR email ILIKE 'cro03%@example.test'
      OR email ILIKE 'stmt-acq-test-%'
      OR first_name ILIKE 'WebhookTest%'
      OR first_name ILIKE 'testnle%'
      OR first_name ILIKE 'StmtTest%'
      OR first_name ILIKE 'StatementTest%'
      OR first_name ILIKE 'GoLive-Test%'
      OR first_name ILIKE 'GoLive Test%'
      OR first_name ILIKE 'Getstarted%'
      OR first_name ILIKE 'Stmttest%'
      OR first_name ILIKE 'DealStage%'
      OR first_name ILIKE 'C1Test%'
      OR first_name ILIKE 'Liberty%DataTest%'
      OR (first_name = 'StmtTest' AND last_name = 'QAUser')
      OR (first_name = 'Test' AND last_name = 'Lead')
      OR (first_name = 'Test' AND last_name = 'Update')
      OR company_name ILIKE 'Test Co%'
      OR company_name ILIKE 'Test Corp%'
      OR company_name ILIKE 'QA_RELEASE_TEST%'
      OR company_name ILIKE 'CRO03B Certification%'
    `;
    const testResult = await tx.execute(sql`
      UPDATE contacts SET record_class = 'test'
      WHERE record_class = 'unknown' AND (${TEST_COND})
    `);
    const testUpdated = (testResult as any)?.rowCount ?? 0;

    // Step 2 — all remaining 'unknown' rows are real production contacts.
    const prodResult = await tx.execute(sql`
      UPDATE contacts SET record_class = 'production'
      WHERE record_class = 'unknown'
    `);
    const prodUpdated = (prodResult as any)?.rowCount ?? 0;

    const total = testUpdated + prodUpdated;
    return {
      id,
      classification: "historical_backfill",
      tables,
      outcome: total > 0 ? "backfilled" : "already_present",
      detail: total > 0
        ? `reclassified ${testUpdated} test + ${prodUpdated} production contacts (was 'unknown')`
        : "no unknown contacts — all previously classified",
    };
  });
}

// ── Target: inbound_request_effects backfill for historical equipment orders ─
// migrations/0205_cro05a_equipment_fulfillment_truth.sql
async function convergeInboundRequestEffects(): Promise<SeedTargetResult> {
  const id = "inbound_request_effects_backfill";
  const tables = ["inbound_request_effects"];
  return withLock(`seed:${id}`, async (tx) => {
    await assertColumns(tx, "inbound_request_effects", { request_id: "uuid", effect_key: "text", state: "text" });
    const inserted = await tx.execute(sql`
      INSERT INTO inbound_request_effects (
        request_id, effect_key, effect_type, state, required, external_side_effect, prerequisites, terminal_reason
      )
      SELECT id, 'internal_notification', 'internal_notification', 'held', TRUE, FALSE,
             '["fulfillment"]'::jsonb, 'FULFILLMENT_DURABLE_EVIDENCE_MISSING'
        FROM inbound_requests
       WHERE source_category = 'website_form' AND source_type = 'equipment_order'
      ON CONFLICT (request_id, effect_key) DO NOTHING
    `);
    const insertedCount = (inserted as any)?.rowCount ?? 0;
    return { id, classification: "historical_backfill", tables, outcome: insertedCount > 0 ? "backfilled" : "already_present", detail: `inserted ${insertedCount} held equipment-order effect row(s)` };
  });
}

// ── Target: mi09_pricing_artifacts + mi09_pricing_schedule_snapshots ───────
// Task #1940: the 9 canonical provider pricing rows and their composite
// snapshot are defined in cro03/mi09-pricing-seed-data.ts (the operator's
// real, already-provided pricing) and applied through
// scripts/seed-mi09-pricing.ts for a human operator running it directly.
// Neither that script nor any migration ever runs against production
// (migrations are never replayed there — see production-schema-ownership.md,
// and the operator script requires a human to invoke it with
// --confirm-env=production from inside that environment). This target
// converges the exact same canonical rows at production startup instead,
// through the same governed, insert-only, no-provider-I/O service functions
// (`reuseOrCreatePricingArtifact` / `createPricingScheduleSnapshot`) the
// script itself calls — never raw SQL, never a blind overwrite of an
// existing artifact.
async function convergeMi09PricingArtifacts(): Promise<SeedTargetResult> {
  const id = "mi09_pricing_artifacts";
  const tables = ["mi09_pricing_artifacts", "mi09_pricing_schedule_snapshots"];
  await assertColumns(db as unknown as Tx, "mi09_pricing_artifacts", {
    provider_key: "text",
    unit_type: "text",
    amount_micros: "bigint",
    artifact_version: "integer",
  });
  await assertColumns(db as unknown as Tx, "mi09_pricing_schedule_snapshots", {
    composite_hash: "text",
    artifact_ids: "jsonb",
  });
  let createdCount = 0;
  const perProvider: string[] = [];
  for (const row of MI09_PRICING_SEED_TABLE) {
    const result = await reuseOrCreatePricingArtifact({
      providerKey: row.providerKey,
      unitType: row.unitType,
      amountMicros: row.amountMicros,
      currency: MI09_PRICING_CURRENCY,
      billingSemantics: row.billingSemantics,
      capturedBy: MI09_PRICING_CAPTURED_BY,
      accountBalanceUnits: MI09_PRICING_ACCOUNT_BALANCE_UNITS ?? undefined,
      sourceUrl: row.sourceUrl ?? undefined,
      artifactVersion: MI09_PRICING_ARTIFACT_VERSION,
    });
    if (!result.reused) createdCount++;
    perProvider.push(`${row.providerKey}=${result.reused ? "reused" : "created"}`);
  }
  const snapshot = await createPricingScheduleSnapshot({ capturedBy: MI09_PRICING_CAPTURED_BY });
  const snapshotState = snapshot.reused ? "reused" : snapshot.renewed ? "renewed" : "created";
  return {
    id,
    classification: "immutable_revision_seed",
    tables,
    outcome: createdCount > 0 ? "inserted" : "already_present",
    detail: `${perProvider.join(", ")}; snapshot ${snapshotState} (id=${snapshot.id}, hash=${snapshot.compositeHash})`,
  };
}

// ── Target: mi09_pool_authority_decision initial value ──────────────────────
// assertPoolAuthorityDecision() (mi09-pilot-authority.ts) hard-blocks every
// MI-09 pilot run until system_settings.mi09_pool_authority_decision exists.
// The owner confirmed the decision (master_leads — the canonical pre-contact
// pool for validated CRO-03 output) but this environment's production DB
// access is read-only, so it can only be recorded through this same startup
// convergence path. This target writes the decision EXACTLY ONCE: if a
// decision already exists (set here on a prior boot, or later changed by an
// operator through the admin UI's PUT endpoint), it is left untouched —
// this must never overwrite a live operator decision on every restart.
async function convergePoolAuthorityDecision(): Promise<SeedTargetResult> {
  const id = "mi09_pool_authority_decision";
  const tables = ["system_settings"];
  const existing = await getPoolAuthorityDecision();
  if (existing) {
    return { id, classification: "schema_required_bootstrap", tables, outcome: "already_present", detail: `pool authority already decided: ${existing.pool} (rev ${existing.revision}, by ${existing.decidedBy})` };
  }
  const decision = await setPoolAuthorityDecision({ pool: "master_leads", decidedBy: "system:seed-convergence" });
  return { id, classification: "schema_required_bootstrap", tables, outcome: "inserted", detail: `recorded initial pool authority decision: ${decision.pool} (rev ${decision.revision})` };
}

// ── Target: mi09/CRO-08A schedule definitions (candidate_enrichment,
// candidate_freshness_refresh) ───────────────────────────────────────────
// Task per docs/cro03d-ceremony-runbook.md Step 9: operator-approved schedule
// *definitions* (never activation — that stays behind the separate MI-09
// pilot-ladder gate in schedule-authority.ts, untouched here). Per-provider
// budgets are derived from the real seeded pricing artifacts (amount_micros),
// doubled from the operator's initial conservative figures per their
// instruction. createCro08aScheduleDefinition() is itself idempotent by
// definitionHash — an unchanged input reuses the existing row; only a
// genuinely different input mints a new definitionVersion — so this target
// is safe to run on every boot.
const CRO08A_SCHEDULE_RETRY_POLICY = { maxAttempts: 3 };
const CRO08A_SCHEDULE_DEAD_LETTER_POLICY = { maxAttempts: 5 };
const CRO08A_SCHEDULE_CREATED_BY = "system:seed-convergence";

async function convergeCro08aCandidateEnrichmentSchedule(): Promise<SeedTargetResult> {
  const id = "cro08a_candidate_enrichment_schedule";
  const tables = ["cro08a_schedule_definitions"];
  const result = await createCro08aScheduleDefinition({
    logicalKey: "candidate_enrichment",
    purpose: "Enrich master_leads candidates via governed CRO-03 provider waterfall (production continuous run)",
    sourceRecipePolicyVersions: { master_leads: 1 },
    cadenceCron: "0 */4 * * *",
    timezone: "UTC",
    windowSeconds: 14400,
    overlapSeconds: 0,
    batchSize: 50,
    concurrencyLimit: 3,
    cursorSemantics: { sourceSystem: "master_leads" },
    budgets: {
      serper: { maxUnitsPerOccurrence: 200 },
      outscraper: { maxUnitsPerOccurrence: 100 },
      apollo: { maxUnitsPerOccurrence: 40 },
      openai: { maxUnitsPerOccurrence: 20000 },
      zerobounce: { maxUnitsPerOccurrence: 200 },
    },
    timeoutMs: 120000,
    leaseMs: 120000,
    heartbeatMs: 30000,
    retryPolicy: CRO08A_SCHEDULE_RETRY_POLICY,
    deadLetterPolicy: CRO08A_SCHEDULE_DEAD_LETTER_POLICY,
    downstreamOwner: "cro08a-enrichment",
    createdBy: CRO08A_SCHEDULE_CREATED_BY,
  });
  return { id, classification: "immutable_revision_seed", tables, outcome: "already_present", detail: `definition present: id=${result.id} version=${result.definitionVersion} hash=${result.definitionHash}` };
}

async function convergeCro08aCandidateFreshnessRefreshSchedule(): Promise<SeedTargetResult> {
  const id = "cro08a_candidate_freshness_refresh_schedule";
  const tables = ["cro08a_schedule_definitions"];
  const result = await createCro08aScheduleDefinition({
    logicalKey: "candidate_freshness_refresh",
    purpose: "Periodically re-validate freshness of already-enriched master_leads records (lightweight revalidation, no new discovery)",
    sourceRecipePolicyVersions: { master_leads: 1 },
    cadenceCron: "0 2 * * *",
    timezone: "UTC",
    windowSeconds: 86400,
    overlapSeconds: 0,
    batchSize: 25,
    concurrencyLimit: 1,
    cursorSemantics: { sourceSystem: "master_leads" },
    budgets: {
      zerobounce: { maxUnitsPerOccurrence: 50 },
    },
    timeoutMs: 180000,
    leaseMs: 180000,
    heartbeatMs: 30000,
    retryPolicy: CRO08A_SCHEDULE_RETRY_POLICY,
    deadLetterPolicy: CRO08A_SCHEDULE_DEAD_LETTER_POLICY,
    downstreamOwner: "cro08a-freshness-refresh",
    createdBy: CRO08A_SCHEDULE_CREATED_BY,
  });
  return { id, classification: "immutable_revision_seed", tables, outcome: "already_present", detail: `definition present: id=${result.id} version=${result.definitionVersion} hash=${result.definitionHash}` };
}

// ── Target: soflo_high_water_entity_id cursor rewind (Task #2002 corrective
// patch, migrations/0297_task2002_soflo_cursor_rewind.sql) ─────────────────
// The migration file's plain UPDATE never runs against production (Drizzle
// migrate() is never pointed at it — see production-schema-ownership.md), so
// the one-time cursor rewind that fixes the South Florida overflow-skip bug
// (selectSunbizBootstrapCandidateWindow previously advanced maxIdExamined
// past eligible-but-unprocessed rows when a scan window held more eligible
// candidates than the microbatch limit) must converge here instead.
//
// Classified historical_backfill: this is a one-time correction of state
// left behind by the buggy selector, not a fixed seed row. It is naturally
// idempotent — the WHERE clause matches only soflo_high_water_entity_id > 0
// while phase='south_florida' and status='paused'; after it rewinds the
// cursor to 0 once, the condition can never match again for this run, so
// repeat boots are a safe no-op. It intentionally does NOT require
// status='paused' to already be true before running (unlike the migration
// file, which was written and reviewed against a verified-paused production
// run) — by the time this runs at boot, an operator may have resumed the
// run, and gating it on a specific status here would make convergence flaky.
// Rewinding the read-only cursor is safe regardless of run status: the
// worst case is one extra re-scan of already-claimed rows, which the
// existing sunbiz_bootstrap_claims NOT EXISTS predicate makes a no-op.
async function convergeSofloCursorRewind(): Promise<SeedTargetResult> {
  const id = "sunbiz_soflo_cursor_rewind_task2002";
  const tables = ["sunbiz_bootstrap_runs"];
  return withLock(`seed:${id}`, async (tx) => {
    await assertColumns(tx, "sunbiz_bootstrap_runs", {
      phase: "text",
      soflo_high_water_entity_id: "integer",
      remaining_high_water_entity_id: "integer",
      high_water_entity_id: "integer",
    });
    const result = await tx.execute(sql`
      UPDATE sunbiz_bootstrap_runs
      SET soflo_high_water_entity_id = 0,
          high_water_entity_id = GREATEST(remaining_high_water_entity_id, 0),
          updated_at = now()
      WHERE id = 'default'
        AND phase = 'south_florida'
        AND soflo_high_water_entity_id > 0
      RETURNING id
    `);
    const rewound = (result as any)?.rowCount ?? 0;
    return {
      id, classification: "historical_backfill", tables,
      outcome: rewound > 0 ? "backfilled" : "already_present",
      detail: rewound > 0
        ? "rewound soflo_high_water_entity_id to 0 to re-scan past the overflow-skip bug window"
        : "no rewind needed (south_florida phase not active with a nonzero cursor, or already rewound)",
    };
  });
}

/**
 * Registry of every production-required seed/backfill target this module
 * owns. `write` performs the insert-only convergence (used at startup);
 * `id`/`classification`/`tables` are also used by the read-only verifier and
 * by scripts/check-migration-seed-registration.ts to flag any future
 * migration that introduces unregistered production-required seed data.
 */
export const SEED_TARGETS: Array<{ id: string; classification: SeedClassification; tables: string[]; write: () => Promise<SeedTargetResult>; seedKeys?: SeedKeyRegistration }> = [
  { id: "commercial_shadow_controls", classification: "schema_required_bootstrap", tables: ["commercial_shadow_controls"], write: convergeCommercialShadowControls },
  { id: "paid_provider_controls", classification: "schema_required_bootstrap", tables: ["provider_controls"], write: convergePaidProviderControls },
  {
    id: "sfp_outreach_policy_v1", classification: "immutable_revision_seed",
    tables: ["sfp_outreach_policy_documents", "sfp_outreach_policy_control"],
    write: convergeSfpOutreachPolicyV1,
    seedKeys: { columns: ["version"], values: [["1"]] },
  },
  { id: "sfp_campaign_staging_default_off_v1", classification: "historical_backfill", tables: ["sfp_programs", "system_settings"], write: convergeSfpCampaignStagingDefaultOff },
  { id: "sfp_staging_source_lineage", classification: "historical_backfill", tables: ["sfp_campaign_staging_intents", "sfp_outreach_eligibility"], write: convergeSfpStagingSourceLineage },
  { id: "commercial_graph_revisions_backfill", classification: "historical_backfill", tables: ["commercial_subject_revisions", "commercial_membership_revisions"], write: convergeCommercialGraphRevisions },
  {
    id: "cro02_purpose_policies", classification: "immutable_revision_seed", tables: ["commercial_purpose_policies"],
    write: async () => {
      await initializeCro02PurposePolicies();
      return { id: "cro02_purpose_policies", classification: "immutable_revision_seed", tables: ["commercial_purpose_policies"], outcome: "already_present", detail: "converged via cro02-purpose-policy-initializer" };
    },
    seedKeys: { columns: ["purpose", "policy_version"], values: CRO02_SEED_KEY_VALUES },
  },
  {
    id: "cro03a_policy_bootstrap", classification: "immutable_revision_seed", tables: ["cro03a_policy_documents", "cro03a_policy_control"],
    write: async () => {
      await initializeCro03aPolicy();
      return { id: "cro03a_policy_bootstrap", classification: "immutable_revision_seed", tables: ["cro03a_policy_documents", "cro03a_policy_control"], outcome: "already_present", detail: "converged via cro03a-policy-initializer" };
    },
    seedKeys: { columns: ["policy_key", "version"], values: [[CRO03A_SEED_POLICY_KEY, String(CRO03A_SEED_POLICY_VERSION)]] },
  },
  {
    id: "cro03_staging_recipes", classification: "immutable_revision_seed", tables: ["cro03_staging_recipes"], write: convergeCro03StagingRecipes,
    seedKeys: { columns: ["recipe_key", "version"], values: [[CRO03_STAGING_RECIPE_KEY, String(CRO03_STAGING_RECIPE_VERSION)]] },
  },
  {
    id: "cr04_qualification_policies", classification: "immutable_revision_seed", tables: ["cr04_qualification_policies"], write: convergeCr04QualificationPolicies,
    seedKeys: { columns: ["version"], values: [["1"]] },
  },
  { id: "cro03_provider_ledger_lineage_repair", classification: "historical_backfill", tables: ["cro03_provider_ledger"], write: convergeCro03LedgerLineage },
  { id: "cr06_campaign_gate_revisions_backfill", classification: "historical_backfill", tables: ["cr06_campaign_gate_revisions"], write: convergeCr06CampaignGateRevisions },
  { id: "inbound_request_effects_backfill", classification: "historical_backfill", tables: ["inbound_request_effects"], write: convergeInboundRequestEffects },
  {
    id: "mi09_pricing_artifacts", classification: "immutable_revision_seed",
    tables: ["mi09_pricing_artifacts", "mi09_pricing_schedule_snapshots"],
    write: convergeMi09PricingArtifacts,
    seedKeys: { columns: ["provider_key", "artifact_version"], values: MI09_PRICING_SEED_KEY_VALUES },
  },
  {
    id: "mi09_pool_authority_decision", classification: "schema_required_bootstrap",
    tables: ["system_settings"], write: convergePoolAuthorityDecision,
    seedKeys: { columns: ["key"], values: [["mi09_pool_authority_decision"]] },
  },
  {
    id: "cro08a_candidate_enrichment_schedule", classification: "immutable_revision_seed",
    tables: ["cro08a_schedule_definitions"], write: convergeCro08aCandidateEnrichmentSchedule,
    seedKeys: { columns: ["logical_key", "created_by"], values: [["candidate_enrichment", CRO08A_SCHEDULE_CREATED_BY]] },
  },
  {
    id: "cro08a_candidate_freshness_refresh_schedule", classification: "immutable_revision_seed",
    tables: ["cro08a_schedule_definitions"], write: convergeCro08aCandidateFreshnessRefreshSchedule,
    seedKeys: { columns: ["logical_key", "created_by"], values: [["candidate_freshness_refresh", CRO08A_SCHEDULE_CREATED_BY]] },
  },
  { id: "sunbiz_soflo_cursor_rewind_task2002", classification: "historical_backfill", tables: ["sunbiz_bootstrap_runs"], write: convergeSofloCursorRewind },
  // sfp_identity_quarantine_business_9555 and sfp_wrong_site_derived_evidence_9555
  // are intentionally NOT registered here. They are single-business, one-off
  // historical-incident repairs (not required gating seeds), and blocking
  // startup on them serializes two more DB transactions ahead of listen() —
  // same class of risk documented on convergeContactRecordClassBackfill below.
  // They run fire-and-forget after listen() in server/index.ts instead so a
  // slow/contended production DB cannot delay port-open past the deploy
  // health-check window.
];

/**
 * Runs every registered target's insert-only convergence, in order, and
 * writes one audit_logs summary row recording the outcome of each. Throws
 * (failing startup closed) if any target ends conflicted/blocked/unexpected,
 * exactly like the pre-existing CRO-02/CRO-03A initializers already did on
 * their own.
 */
export async function runProductionSeedConvergence(): Promise<SeedConvergenceReport> {
  const results: SeedTargetResult[] = [];
  let firstError: unknown = null;
  for (const target of SEED_TARGETS) {
    try {
      results.push(await target.write());
    } catch (error: any) {
      results.push({ id: target.id, classification: target.classification, tables: target.tables, outcome: "unexpected", detail: String(error?.message ?? error) });
      if (!firstError) firstError = error;
    }
  }
  const report: SeedConvergenceReport = { runAt: new Date().toISOString(), ok: !firstError, results };
  try {
    await storage.createAuditLog({
      action: "production_seed_convergence_completed",
      entityType: "system",
      entityKey: "production-seed-convergence",
      details: report as any,
      actorType: "system",
      actorId: "production-seed-convergence",
    } as any);
  } catch (auditError) {
    console.error("[ProductionSeedConvergence] Failed to write summary audit log (non-fatal):", auditError);
  }
  if (firstError) {
    console.error("[ProductionSeedConvergence] One or more targets failed:", JSON.stringify(report.results, null, 2));
    throw firstError;
  }
  console.log(`[ProductionSeedConvergence] All ${results.length} targets converged:`, results.map((r) => `${r.id}=${r.outcome}`).join(", "));
  return report;
}

/**
 * Read-only verification used by health checks (no writes, safe to call on
 * every health-check tick). Reports "unexpected" for any target whose
 * required row(s) are missing or diverge from canonical content, without
 * attempting to repair it — repair only happens via runProductionSeedConvergence
 * at startup.
 */
export async function verifyProductionSeedConvergence(): Promise<SeedConvergenceReport> {
  const results: SeedTargetResult[] = [];
  const checks: Array<() => Promise<SeedTargetResult>> = [
    async () => {
      const row = rows(await db.execute(sql`SELECT control_key FROM commercial_shadow_controls WHERE control_key = 'commercial'`))[0];
      return { id: "commercial_shadow_controls", classification: "schema_required_bootstrap", tables: ["commercial_shadow_controls"], outcome: row ? "already_present" : "unexpected", detail: row ? "present" : "missing control row" };
    },
    async () => {
      const missingSubjects = rows(await db.execute(sql`
        WITH required AS (
          SELECT DISTINCT 'contact' t, contact_id i FROM contact_business_link_decisions
          UNION SELECT 'business', business_id FROM contact_business_link_decisions WHERE business_id IS NOT NULL
          UNION SELECT 'company', company_id FROM legacy_company_mapping_decisions
          UNION SELECT 'business', business_id FROM legacy_company_mapping_decisions WHERE business_id IS NOT NULL
          UNION SELECT 'contact', contact_id FROM commercial_relationship_reviews
          UNION SELECT 'business', business_id FROM commercial_relationship_reviews WHERE business_id IS NOT NULL
          UNION SELECT 'contact', contact_id FROM contact_identity_observations
          UNION SELECT 'contact', deprecated_contact_id FROM contact_merge_redirects
          UNION SELECT 'contact', survivor_contact_id FROM contact_merge_redirects
        )
        SELECT count(*)::int AS n FROM required r
        LEFT JOIN commercial_subject_revisions csr ON csr.subject_type = r.t AND csr.subject_id = r.i
        WHERE csr.subject_id IS NULL
      `))[0];
      const n = Number(missingSubjects?.n ?? 0);
      const missingMemberships = rows(await db.execute(sql`
        WITH required AS (
          SELECT 'contact_business' e, 'contact' lt, contact_id li,
                 CASE WHEN business_id IS NULL THEN 'contact' ELSE 'business' END rt, COALESCE(business_id, contact_id) ri
            FROM contact_business_link_decisions
          UNION SELECT 'legacy_company_business', 'company', company_id,
                 CASE WHEN business_id IS NULL THEN 'company' ELSE 'business' END, COALESCE(business_id, company_id)
            FROM legacy_company_mapping_decisions
          UNION SELECT 'relationship', 'contact', contact_id,
                 CASE WHEN business_id IS NULL THEN 'contact' ELSE 'business' END, COALESCE(business_id, contact_id)
            FROM commercial_relationship_reviews
          UNION SELECT 'identity', 'contact', contact_id, 'contact', contact_id FROM contact_identity_observations
          UNION SELECT 'contact_redirect', 'contact', deprecated_contact_id, 'contact', survivor_contact_id FROM contact_merge_redirects
        )
        SELECT count(*)::int AS n FROM required r
        LEFT JOIN commercial_membership_revisions cmr
          ON cmr.edge_type = r.e AND cmr.left_subject_type = r.lt AND cmr.left_subject_id = r.li
         AND cmr.right_subject_type = r.rt AND cmr.right_subject_id = r.ri
        WHERE cmr.edge_type IS NULL
      `))[0];
      const m = Number(missingMemberships?.n ?? 0);
      const ok = n === 0 && m === 0;
      const parts = [n === 0 ? "no missing subject revisions" : `${n} subject(s) missing a revision row`, m === 0 ? "no missing membership revisions" : `${m} membership edge(s) missing a revision row`];
      return { id: "commercial_graph_revisions_backfill", classification: "historical_backfill", tables: ["commercial_subject_revisions", "commercial_membership_revisions"], outcome: ok ? "already_present" : "unexpected", detail: parts.join("; ") };
    },
    async () => {
      // Presence of >=8 shadow-mode rows is not sufficient — a row could be
      // deleted and replaced with a non-canonical (purpose, policy_version)
      // pair and still pass a bare count check. Verify every one of the
      // exact registered canonical key pairs is present in shadow mode.
      const present = rows(await db.execute(sql`SELECT purpose, policy_version FROM commercial_purpose_policies WHERE mode = 'shadow'`));
      const presentKeys = new Set(present.map((r: any) => `${r.purpose}::${r.policy_version}`));
      const missing = CRO02_SEED_KEY_VALUES.filter(([purpose, version]) => !presentKeys.has(`${purpose}::${version}`));
      return { id: "cro02_purpose_policies", classification: "immutable_revision_seed", tables: ["commercial_purpose_policies"], outcome: missing.length === 0 ? "already_present" : "unexpected", detail: missing.length === 0 ? `all ${CRO02_SEED_KEY_VALUES.length} canonical purpose policy keys present in shadow mode` : `missing canonical key(s): ${missing.map((k) => k.join("/")).join(", ")}` };
    },
    async () => {
      // Two-part check, kept deliberately separate so each failure reports
      // a distinct detail string:
      //
      //   (a) The immutable v1 seed row must still exist in cro03a_policy_documents.
      //       It is append-only, so it can never disappear after the migration
      //       that inserted it — but production's Publish-managed schema could
      //       be missing it if the convergence initializer was never reached.
      //
      //   (b) The cro03a_policy_control pointer must resolve to a document with
      //       the canonical policy_key ("south_florida_candidate_qualification")
      //       and a hash that matches its stored policy field.  The version is
      //       NOT constrained here — the operator may have legitimately promoted
      //       a later version (e.g. v3), which must not permanently break this
      //       health check.
      //
      // Both assertions must pass; whichever fails first is surfaced as the
      // detail message.  Return "already_present" only when both pass.
      const v1Row = rows(await db.execute(sql`
        SELECT id, policy_hash FROM cro03a_policy_documents
         WHERE policy_key = ${CRO03A_SEED_POLICY_KEY}
           AND version = ${CRO03A_SEED_POLICY_VERSION}
         LIMIT 1
      `))[0];
      if (!v1Row) {
        return {
          id: "cro03a_policy_bootstrap", classification: "immutable_revision_seed" as const,
          tables: ["cro03a_policy_documents", "cro03a_policy_control"],
          outcome: "unexpected" as const,
          detail: `v1 canonical seed row missing from cro03a_policy_documents (policy_key=${CRO03A_SEED_POLICY_KEY} version=${CRO03A_SEED_POLICY_VERSION})`,
        };
      }
      if (String(v1Row.policy_hash) !== CRO03A_SEED_POLICY_HASH) {
        return {
          id: "cro03a_policy_bootstrap", classification: "immutable_revision_seed" as const,
          tables: ["cro03a_policy_documents", "cro03a_policy_control"],
          outcome: "unexpected" as const,
          detail: `v1 seed row hash diverges from canonical (stored=${v1Row.policy_hash} expected=${CRO03A_SEED_POLICY_HASH})`,
        };
      }
      const controlRow = rows(await db.execute(sql`
        SELECT d.policy_key, d.version, d.policy_hash, d.policy
          FROM cro03a_policy_control c
          JOIN cro03a_policy_documents d ON d.id = c.active_policy_id
         WHERE c.id = 1
      `))[0];
      if (!controlRow) {
        return {
          id: "cro03a_policy_bootstrap", classification: "immutable_revision_seed" as const,
          tables: ["cro03a_policy_documents", "cro03a_policy_control"],
          outcome: "unexpected" as const,
          detail: `cro03a_policy_control active pointer is unset or does not resolve to a document`,
        };
      }
      if (String(controlRow.policy_key) !== CRO03A_SEED_POLICY_KEY) {
        return {
          id: "cro03a_policy_bootstrap", classification: "immutable_revision_seed" as const,
          tables: ["cro03a_policy_documents", "cro03a_policy_control"],
          outcome: "unexpected" as const,
          detail: `active pointer resolves to wrong policy_key: expected=${CRO03A_SEED_POLICY_KEY} got=${controlRow.policy_key}`,
        };
      }
      // Verify the pointed-at document's stored hash matches the policy field
      // (guards against silent in-place mutation of a policy document).
      const { hashCro03Evidence } = await import("./cro03/source-staging");
      const computedHash = hashCro03Evidence(
        typeof controlRow.policy === "string" ? JSON.parse(controlRow.policy) : controlRow.policy,
      );
      if (computedHash !== String(controlRow.policy_hash)) {
        return {
          id: "cro03a_policy_bootstrap", classification: "immutable_revision_seed" as const,
          tables: ["cro03a_policy_documents", "cro03a_policy_control"],
          outcome: "unexpected" as const,
          detail: `active policy document hash invalid: stored=${controlRow.policy_hash} computed=${computedHash} (version=${controlRow.version})`,
        };
      }
      return {
        id: "cro03a_policy_bootstrap", classification: "immutable_revision_seed" as const,
        tables: ["cro03a_policy_documents", "cro03a_policy_control"],
        outcome: "already_present" as const,
        detail: `v1 seed row present (hash valid); active pointer resolves to ${CRO03A_SEED_POLICY_KEY}/v${controlRow.version} (hash valid)`,
      };
    },
    async () => {
      const row = rows(await db.execute(sql`SELECT recipe_hash, status FROM cro03_staging_recipes WHERE recipe_key = ${CRO03_STAGING_RECIPE_KEY} AND version = ${CRO03_STAGING_RECIPE_VERSION}`))[0];
      const matches = row && String(row.recipe_hash) === CRO03_STAGING_RECIPE_HASH && row.status === "disabled";
      return { id: "cro03_staging_recipes", classification: "immutable_revision_seed", tables: ["cro03_staging_recipes"], outcome: matches ? "already_present" : "unexpected", detail: matches ? "canonical recipe hash matches" : row ? "recipe present but hash/status diverges from canonical" : "missing canonical recipe" };
    },
    async () => {
      const row = rows(await db.execute(sql`SELECT status, decision_ttl_seconds, taxonomy_version, document FROM cr04_qualification_policies WHERE version = 1`))[0];
      const matches = row && row.status === "active" && Number(row.decision_ttl_seconds) === 900 &&
        row.taxonomy_version === "cr04-reasons-v1" && stableStringify(row.document) === stableStringify(CR04_POLICY_DOCUMENT);
      return { id: "cr04_qualification_policies", classification: "immutable_revision_seed", tables: ["cr04_qualification_policies"], outcome: matches ? "already_present" : "unexpected", detail: matches ? "canonical v1 policy document matches" : row ? "v1 policy present but content diverges from canonical" : "missing v1 active policy" };
    },
    async () => {
      const row = rows(await db.execute(sql`SELECT count(*)::int AS n FROM cro03_provider_ledger WHERE event_type = 'terminal' AND reservation_entry_id IS NULL`))[0];
      const n = Number(row?.n ?? 0);
      return { id: "cro03_provider_ledger_lineage_repair", classification: "historical_backfill", tables: ["cro03_provider_ledger"], outcome: n === 0 ? "already_present" : "unexpected", detail: n === 0 ? "no orphaned terminal entries" : `${n} terminal entr${n === 1 ? "y" : "ies"} missing reservation lineage` };
    },
    async () => {
      const row = rows(await db.execute(sql`
        SELECT count(*)::int AS n FROM cr06_campaign_gates g
        LEFT JOIN cr06_campaign_gate_revisions r ON r.campaign_gate_id = g.id AND r.revision = g.revision
        WHERE r.id IS NULL
      `))[0];
      const n = Number(row?.n ?? 0);
      return { id: "cr06_campaign_gate_revisions_backfill", classification: "historical_backfill", tables: ["cr06_campaign_gate_revisions"], outcome: n === 0 ? "already_present" : "unexpected", detail: n === 0 ? "no missing gate revisions" : `${n} gate(s) missing their current revision row` };
    },
    async () => {
      const row = rows(await db.execute(sql`
        SELECT count(*)::int AS n FROM inbound_requests ir
        LEFT JOIN inbound_request_effects e ON e.request_id = ir.id AND e.effect_key = 'internal_notification'
        WHERE ir.source_category = 'website_form' AND ir.source_type = 'equipment_order' AND e.id IS NULL
      `))[0];
      const n = Number(row?.n ?? 0);
      return { id: "inbound_request_effects_backfill", classification: "historical_backfill", tables: ["inbound_request_effects"], outcome: n === 0 ? "already_present" : "unexpected", detail: n === 0 ? "no missing effect rows" : `${n} equipment-order request(s) missing their held effect row` };
    },
    async () => {
      const row = rows(await db.execute(sql`SELECT count(*)::int AS n FROM contacts WHERE record_class = 'unknown'`))[0];
      const n = Number(row?.n ?? 0);
      return { id: "contact_record_class_backfill", classification: "historical_backfill", tables: ["contacts"], outcome: n === 0 ? "already_present" : "unexpected", detail: n === 0 ? "no unknown-class contacts remain" : `${n} contact(s) still have record_class='unknown'` };
    },
    async () => {
      const id = "mi09_pricing_artifacts";
      const tables = ["mi09_pricing_artifacts", "mi09_pricing_schedule_snapshots"];
      const present = rows(await db.execute(sql`
        SELECT DISTINCT provider_key, artifact_version FROM mi09_pricing_artifacts
      `));
      const presentKeys = new Set(present.map((r: any) => `${r.provider_key}::${r.artifact_version}`));
      const missing = MI09_PRICING_SEED_KEY_VALUES.filter(([provider, version]) => !presentKeys.has(`${provider}::${version}`));
      if (missing.length > 0) {
        return { id, classification: "immutable_revision_seed", tables, outcome: "unexpected", detail: `missing canonical pricing artifact(s): ${missing.map((k) => k.join("/")).join(", ")}` };
      }
      const snapshotCount = rows(await db.execute(sql`SELECT count(*)::int AS n FROM mi09_pricing_schedule_snapshots`))[0];
      if (Number(snapshotCount?.n ?? 0) === 0) {
        return { id, classification: "immutable_revision_seed", tables, outcome: "unexpected", detail: `all ${MI09_PRICING_SEED_KEY_VALUES.length} canonical pricing artifacts present but no composite pricing schedule snapshot exists` };
      }
      return { id, classification: "immutable_revision_seed", tables, outcome: "already_present", detail: `all ${MI09_PRICING_SEED_KEY_VALUES.length} canonical pricing artifact keys present; snapshot(s) exist` };
    },
    async () => {
      const id = "mi09_pool_authority_decision";
      const tables = ["system_settings"];
      const decision = await getPoolAuthorityDecision();
      if (!decision?.pool) {
        return { id, classification: "schema_required_bootstrap", tables, outcome: "unexpected", detail: "mi09_pool_authority_decision is not set" };
      }
      return { id, classification: "schema_required_bootstrap", tables, outcome: "already_present", detail: `pool authority decided: ${decision.pool} (rev ${decision.revision}, by ${decision.decidedBy})` };
    },
    async () => {
      const id = "cro08a_candidate_enrichment_schedule";
      const tables = ["cro08a_schedule_definitions"];
      const row = rows(await db.execute(sql`SELECT id, active, budgets FROM cro08a_schedule_definitions WHERE logical_key = 'candidate_enrichment' AND created_by = ${CRO08A_SCHEDULE_CREATED_BY} ORDER BY definition_version DESC LIMIT 1`))[0];
      return { id, classification: "immutable_revision_seed", tables, outcome: row ? "already_present" : "unexpected", detail: row ? `definition present: id=${row.id} active=${row.active}` : "no canonical candidate_enrichment definition found" };
    },
    async () => {
      const id = "cro08a_candidate_freshness_refresh_schedule";
      const tables = ["cro08a_schedule_definitions"];
      const row = rows(await db.execute(sql`SELECT id, active, budgets FROM cro08a_schedule_definitions WHERE logical_key = 'candidate_freshness_refresh' AND created_by = ${CRO08A_SCHEDULE_CREATED_BY} ORDER BY definition_version DESC LIMIT 1`))[0];
      return { id, classification: "immutable_revision_seed", tables, outcome: row ? "already_present" : "unexpected", detail: row ? `definition present: id=${row.id} active=${row.active}` : "no canonical candidate_freshness_refresh definition found" };
    },
    async () => {
      const id = "sunbiz_soflo_cursor_rewind_task2002";
      const tables = ["sunbiz_bootstrap_runs"];
      const row = rows(await db.execute(sql`
        SELECT phase, soflo_high_water_entity_id FROM sunbiz_bootstrap_runs WHERE id = 'default'
      `))[0];
      // Not provisioned yet, or convergence already ran (or was never
      // needed): either way there is nothing left for it to rewind.
      const stillNeedsRewind = row && row.phase === "south_florida" && Number(row.soflo_high_water_entity_id) > 0;
      return {
        id, classification: "historical_backfill", tables,
        outcome: stillNeedsRewind ? "unexpected" : "already_present",
        detail: stillNeedsRewind
          ? `south_florida phase cursor still at ${row.soflo_high_water_entity_id} — convergence rewind has not run yet`
          : "no pending rewind (row absent, past south_florida phase, or already rewound)",
      };
    },
    async () => {
      const id = "sfp_wrong_site_derived_evidence_9555";
      const tables = ["sfp_discredited_processor_signals", "sfp_discredited_free_enrichment_summaries", "processor_signals", "businesses"];
      const state = rows(await db.execute(sql`
        SELECT EXISTS(SELECT 1 FROM businesses WHERE id = ${SFP_9555_BUSINESS_ID}
            AND LOWER(BTRIM(canonical_name)) LIKE 'prolawn & landscaping%') AS incident_present,
          EXISTS(SELECT 1 FROM sfp_discredited_processor_signals WHERE signal_id = 1548
            AND business_id = ${SFP_9555_BUSINESS_ID} AND reason_code = 'SERPER_WRONG_GEOGRAPHY'
            AND original_row->>'vendor_name' = 'Squarespace Commerce'
            AND original_row->>'detection_method' = 'script') AS signal_archived,
          EXISTS(SELECT 1 FROM processor_signals WHERE id = 1548 AND business_id = ${SFP_9555_BUSINESS_ID}) AS signal_live,
          EXISTS(SELECT 1 FROM sfp_discredited_free_enrichment_summaries WHERE business_id = ${SFP_9555_BUSINESS_ID}
            AND reason_code = 'SERPER_WRONG_GEOGRAPHY'
            AND original_evidence->>'collectedAt' = '2026-09-28T01:06:23.035Z') AS summary_archived,
          (SELECT free_enrichment_evidence IS NULL FROM businesses WHERE id = ${SFP_9555_BUSINESS_ID}) AS summary_cleared
      `))[0];
      const ok = !state?.incident_present || (state.signal_archived &&
        !state.signal_live && state.summary_archived && state.summary_cleared);
      return { id, classification: "historical_backfill", tables, outcome: ok ? "already_present" : "unexpected",
        detail: !state?.incident_present ? "production incident business absent" : ok
          ? "wrong-site derived evidence archived and absent from live business"
          : "business 9555 still has unarchived or live wrong-site derived evidence" };
    },
  ];
  for (const check of checks) {
    try {
      results.push(await check());
    } catch (error: any) {
      results.push({ id: "unknown", classification: "schema_required_bootstrap", tables: [], outcome: "unexpected", detail: String(error?.message ?? error) });
    }
  }
  return { runAt: new Date().toISOString(), ok: results.every((r) => r.outcome !== "unexpected" && r.outcome !== "conflicted" && r.outcome !== "blocked"), results };
}
