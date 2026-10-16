/**
 * south-florida-prospecting.ts
 *
 * Independent South Florida Prospecting program.
 *
 * Works when:
 *   - master_leads = 0
 *   - No MI-09 pilot run exists
 *   - No CRO-03A qualification handoff exists
 *   - No paid provider has run
 *
 * Operator flow:
 *   1. ensureProgram()           → idempotent program definition
 *   2. previewFunnel()           → read-only funnel / ROI preview
 *   3. freezeCohort()            → deterministic cohort freeze (idempotent)
 *   4. runFreeDiscovery()        → no-cost evidence collection
 *   5. previewPaidEscalation()   → cost preview per provider
 *   6. executePaidWaterfall()    → operator-authorized bounded paid run
 *   7. previewValidation()       → ZeroBounce preview + cost
 *   8. executeValidation()       → bounded validation via canonical admission
 *   9. stageForCampaign()        → idempotent, re-checks all gates
 *
 * All paid stages require explicit operator authorization; no automatic sending.
 */

import { sql, type SQL } from "drizzle-orm";
import { db, pool } from "../../db";
import { createHash } from "crypto";
import { randomUUID } from "crypto";
import { sanitizeAuditPayload } from "../audit-sanitizer";
import { selectRoiCohort, loadPilotVerticalIds, ROI_SCORE_VERSION, type RoiCohortSelection } from "./roi-cohort-selector";
import { unseal as unsealCandidateEvidence } from "./candidate-evidence-service";
import { CRO03A_COUNTY_FIPS } from "../cro03a/geography";
import { CLASSIFIER_VERSION, SFP_TARGET_VERTICALS_V2, TAXONOMY_VERSION_V2 } from "./sfp-vertical-classifier";
import { GEOGRAPHY_RESOLVER_VERSION } from "./sfp-geography-resolver";
// The selector loads latest admissible evidence for the complete census in the
// same transaction snapshot and attaches it to each decision candidate.
import {
  getActiveSfpOutreachPolicy,
  evaluateSfpMutableSafetyGates,
  isCanonicallySuppressed,
  lookupConsentTierByEmailHash,
  lockCurrentSfpOutreachPolicy,
} from "./sfp-outreach-policy";
import { lockSfpContactAddress } from "./sfp-contact-address-lock";
import {
  lockSfpBusinessSafetySentinel,
  lockSfpEligibilityProjectionKey,
  lockSfpEligibilityProjectionWriteGate,
} from "./sfp-eligibility-locks";
import {
  isCurrentSfpValidationReceiptFresh,
  normalizedSfpEmailHash,
} from "./sfp-recipient-link-predicates";
import { storage } from "../../storage";
import {
  SFP_SELECTED_CONTACTS_MAX,
  normalizeFrozenContactScope,
  normalizeSelectedContactIds,
  resolveVerifiedSfpContactTargets,
  type SfpSelectedContactTarget,
} from "./sfp-contact-scope";

/**
 * Admin-auditable override for the FREE_DISCOVERY_VALIDATION_PROMOTION_ENABLED
 * gate. Previously this gate was readable only via a raw environment
 * variable, requiring a redeploy to flip and leaving no audit trail. The
 * system_settings key below lets an admin close the gate even when the env
 * var is "true" (explicit "false" always wins — fail-closed), or open it
 * without redeploying when the env var is unset/false ("true" opens it).
 * Unset (null) defers entirely to the env var, preserving prior behavior.
 */
const SFP_VALIDATION_PROMOTION_OVERRIDE_KEY = "sfp_validation_promotion_override_enabled";

export async function isSfpValidationPromotionEnabled(): Promise<boolean> {
  const override = await storage.getSystemSetting(SFP_VALIDATION_PROMOTION_OVERRIDE_KEY).catch(() => null);
  if (override === true || override === "true") return true;
  if (override === false || override === "false") return false;
  return process.env.FREE_DISCOVERY_VALIDATION_PROMOTION_ENABLED === "true";
}

export async function setSfpValidationPromotionOverride(input: {
  value: boolean | null;
  actorId: string;
}): Promise<{ override: boolean | null; effective: boolean }> {
  await storage.setSystemSetting(SFP_VALIDATION_PROMOTION_OVERRIDE_KEY, input.value);
  const effective = await isSfpValidationPromotionEnabled();
  await db.execute(sql`
    INSERT INTO audit_logs (action, entity_type, entity_key, actor_type, actor_id, details)
    VALUES ('sfp_validation_promotion_override_changed', 'system_setting', ${SFP_VALIDATION_PROMOTION_OVERRIDE_KEY},
            'user', ${input.actorId}, ${JSON.stringify(sanitizeAuditPayload({ override: input.value, effective }))}::jsonb)
  `);
  return { override: input.value, effective };
}

const rows = (r: any): any[] => r?.rows ?? r ?? [];

/**
 * Marks an expected, stable control-flow outcome from freezeCohortTx —
 * idempotent replay mismatch, a key that already failed, or a key pinned to
 * a terminal (voided/superseded) run. These are not new freeze failures:
 * the existing row already durably reflects the truth, so freezeCohort's
 * catch block must recognize them via `instanceof` (a structured domain
 * type, not fragile message-substring sniffing) and re-throw them exactly
 * as-is, WITHOUT attempting any failure-persistence write. See Correction 2:
 * a failure-persistence write for one of these would collide with the
 * existing row's own unique idempotency_key and mask the real, stable error
 * code behind SFP_FREEZE_FAILURE_PERSISTENCE_FAILED.
 */
class SfpStableControlFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SfpStableControlFlowError";
  }
}
function stableError(message: string): SfpStableControlFlowError {
  return new SfpStableControlFlowError(message);
}

const PROGRAM_NAME = "south-florida-v1";
const SOUTH_FLORIDA_FIPS = Object.values(CRO03A_COUNTY_FIPS);
const SFP_POLICY_VERSION = 1;
/**
 * Bump whenever the exclusion rules applied during cohort selection change
 * (DBPR exclusion, existing-customer exclusion, test/demo/internal exclusion,
 * suppression exclusion, bounced/invalid-only exclusion, inactive-entity
 * exclusion — see roi-cohort-selector.ts). Tracked independently of
 * SFP_POLICY_VERSION so a change to *which businesses get excluded* is
 * visible in the frozen manifest even when the program's own policy
 * (verticals/counties/cohort cap) has not changed.
 */
const EXCLUSION_POLICY_VERSION = 1;

// ── Outreach eligibility status enum ──────────────────────────────────────────
export type OutreachEligibilityStatus =
  | "validated_outreach_eligible"
  | "validated_review_required"
  | "validated_suppressed"
  | "validated_existing_relationship"
  | "validated_policy_ineligible"
  | "validation_pending"
  | "catch_all_review"
  | "invalid"
  | "discovery_required";

// ── Program ────────────────────────────────────────────────────────────────────

export interface SfpProgram {
  id: string;
  name: string;
  countyFips: string[];
  verticalIds: string[];
  maxCohortSize: number;
  policyVersion: number;
  taxonomyVersion: 1 | 2;
  isActive: boolean;
  recurringEnabled: boolean;
  campaignStagingBatchSize: number;
  activatedAt: string | null;
  createdAt: string;
  createdBy: string;
}

/**
 * Idempotent program definition. Creates or returns the existing program.
 * The program starts inactive — operator must explicitly activate after publish.
 */
/**
 * SFP's own default target-vertical IDs. This is the sole runtime authority
 * for program configuration once a program row exists — the legacy
 * `system_settings.cro03c_roi_pilot_verticals` value is NEVER read here.
 * It is only ever consumed through the explicit, audited, one-time
 * `initializeProgramFromLegacyConfig` path below, and only when no SFP
 * program configuration exists yet.
 */
const SFP_DEFAULT_VERTICAL_IDS = ["Med Spa", "Dental", "Auto Repair", "Restaurant", "Retail"];

/**
 * South Florida program target-vertical taxonomy v2 defaults (Automotive,
 * Healthcare, Beauty/Spa, Construction/Trades/Home Services,
 * Fitness/Recreation). Used for brand-new program creation only — an
 * existing program row is never silently reconverged; see
 * migrateProgramToTargetVerticalsV2 for the explicit, audited one-time move.
 */
const SFP_DEFAULT_VERTICAL_IDS_V2 = [...SFP_TARGET_VERTICALS_V2];

/**
 * Idempotent program definition. Creates the program with SFP-owned defaults
 * on first call and returns the existing row on every subsequent call.
 * Unlike earlier revisions, this NEVER reconverges county_fips/vertical_ids/
 * policy_version from any external source (including the legacy
 * cro03c_roi_pilot_verticals system_settings key) on every call — once a
 * program row exists, its configuration is mutable only through an explicit
 * admin action (setProgramActivation, a future config-update endpoint, or
 * the one-time legacy initializer below).
 */
export async function ensureProgram(opts: {
  createdBy?: string;
  maxCohortSize?: number;
} = {}): Promise<SfpProgram> {
  const existing = rows(await db.execute(sql`
    SELECT * FROM sfp_programs WHERE name = ${PROGRAM_NAME} LIMIT 1
  `))[0];
  if (existing) return _mapProgram(existing);

  const countyFips = [...SOUTH_FLORIDA_FIPS];
  // Brand-new South Florida programs default to the v2 target-vertical
  // taxonomy (Automotive, Healthcare, Beauty/Spa, Construction/Trades/Home
  // Services, Fitness/Recreation). An existing program row is never
  // reconverged here — see migrateProgramToTargetVerticalsV2 for moving a
  // pre-existing v1 program over explicitly.
  const verticalIds = [...SFP_DEFAULT_VERTICAL_IDS_V2];

  const created = rows(await db.execute(sql`
    INSERT INTO sfp_programs
      (name, county_fips, vertical_ids, max_cohort_size, policy_version, taxonomy_version, schedule_config, is_active, created_by)
    VALUES (
      ${PROGRAM_NAME},
      ARRAY[${sql.join(countyFips.map((f) => sql`${f}`), sql`, `)}],
      ARRAY[${sql.join(verticalIds.map((v) => sql`${v}`), sql`, `)}],
      ${Math.max(1, Math.min(100, opts.maxCohortSize ?? 100))},
      ${SFP_POLICY_VERSION},
      ${TAXONOMY_VERSION_V2},
      ${JSON.stringify({ freeBatch: 25, paidBatch: 10, validationBatch: 25, campaignStaging: 0 })}::jsonb,
      false,
      ${opts.createdBy ?? "system:sfp"}
    )
    ON CONFLICT (name) DO NOTHING
    RETURNING *
  `))[0];
  if (created) return _mapProgram(created);

  // Lost the create race to a concurrent caller — read back the winner's row.
  const winner = rows(await db.execute(sql`
    SELECT * FROM sfp_programs WHERE name = ${PROGRAM_NAME} LIMIT 1
  `))[0];
  return _mapProgram(winner);
}

/**
 * Explicit, audited, ONE-TIME initializer that seeds the SFP program's
 * target-vertical configuration from the legacy
 * `system_settings.cro03c_roi_pilot_verticals` key. Only fires when no SFP
 * program configuration exists yet; every other read/preview/freeze path
 * never touches this key. Writes a permanent audit receipt (source,
 * source hash, resulting config, actor, timestamp) so the origin of the
 * configuration is always traceable.
 */
export async function initializeProgramFromLegacyConfig(opts: {
  actorId: string;
}): Promise<{ program: SfpProgram; initialized: boolean; reason?: string }> {
  const existing = await getProgramReadOnly();
  if (existing) {
    return { program: existing, initialized: false, reason: "SFP_PROGRAM_ALREADY_CONFIGURED" };
  }

  const legacyVerticalIds = await loadPilotVerticalIds();
  const countyFips = [...SOUTH_FLORIDA_FIPS];
  const sourceHash = createHash("sha256").update(JSON.stringify(legacyVerticalIds)).digest("hex");

  const created = rows(await db.execute(sql`
    INSERT INTO sfp_programs
      (name, county_fips, vertical_ids, max_cohort_size, policy_version, is_active, created_by)
    VALUES (
      ${PROGRAM_NAME},
      ARRAY[${sql.join(countyFips.map((f) => sql`${f}`), sql`, `)}],
      ARRAY[${sql.join(legacyVerticalIds.map((v) => sql`${v}`), sql`, `)}],
      100,
      ${SFP_POLICY_VERSION},
      false,
      ${opts.actorId}
    )
    ON CONFLICT (name) DO NOTHING
    RETURNING *
  `))[0];

  if (!created) {
    // Lost the race — another caller created the program between the
    // read-only check and this insert. No initialization happened here.
    const winner = await getProgramReadOnly();
    return { program: winner!, initialized: false, reason: "SFP_PROGRAM_CREATED_CONCURRENTLY" };
  }

  await db.execute(sql`
    INSERT INTO sfp_config_init_receipts (program_id, source, source_hash, resulting_config, actor_id)
    VALUES (${String(created.id)}::uuid, 'system_settings.cro03c_roi_pilot_verticals', ${sourceHash},
            ${JSON.stringify({ countyFips, verticalIds: legacyVerticalIds })}::jsonb, ${opts.actorId})
  `);
  await db.execute(sql`
    INSERT INTO audit_logs (action, entity_type, entity_key, actor_type, actor_id, details)
    VALUES ('sfp_program_initialized_from_legacy_config', 'sfp_program', ${String(created.id)}, 'user', ${opts.actorId},
            ${JSON.stringify(sanitizeAuditPayload({ source: "cro03c_roi_pilot_verticals", sourceHash, verticalIds: legacyVerticalIds }))}::jsonb)
  `);

  return { program: _mapProgram(created), initialized: true };
}

/**
 * Explicit, audited, one-time move of an EXISTING South Florida program from
 * the legacy v1 target-vertical taxonomy to v2 (Automotive, Healthcare,
 * Beauty/Spa, Construction/Trades/Home Services, Fitness/Recreation).
 * Bumps policy_version so every classification-evidence and cohort-scoring
 * consumer keyed on (policy_version, classifier_version) treats this as a
 * distinct configuration — no v1-classified business can silently bleed
 * into v2 admission decisions or vice versa. No-ops (returns
 * migrated:false) if the program is already on v2, so it is safe to call
 * repeatedly. Does not touch the Sunbiz South Florida discovery worker's
 * own cursor — this only changes SFP's classification/cohort configuration.
 */
export async function migrateProgramToTargetVerticalsV2(opts: {
  actorId: string;
}): Promise<{ program: SfpProgram; migrated: boolean; reason?: string }> {
  const existing = rows(await db.execute(sql`
    SELECT * FROM sfp_programs WHERE name = ${PROGRAM_NAME} LIMIT 1
  `))[0];
  if (!existing) throw new Error("SFP_PROGRAM_NOT_FOUND");
  if (Number(existing.taxonomy_version) === 2) {
    return { program: _mapProgram(existing), migrated: false, reason: "SFP_PROGRAM_ALREADY_ON_TAXONOMY_V2" };
  }
  const newVerticalIds = [...SFP_DEFAULT_VERTICAL_IDS_V2];
  const previousVerticalIds = Array.isArray(existing.vertical_ids) ? existing.vertical_ids : [];
  const previousPolicyVersion = Number(existing.policy_version ?? 1);
  const updated = rows(await db.execute(sql`
    UPDATE sfp_programs
       SET vertical_ids = ARRAY[${sql.join(newVerticalIds.map((v) => sql`${v}`), sql`, `)}],
           taxonomy_version = ${TAXONOMY_VERSION_V2},
           policy_version = policy_version + 1
     WHERE id = ${String(existing.id)}::uuid AND taxonomy_version = 1
     RETURNING *
  `))[0];
  if (!updated) {
    // Lost the race to a concurrent migration call.
    const winner = rows(await db.execute(sql`SELECT * FROM sfp_programs WHERE id = ${String(existing.id)}::uuid`))[0];
    return { program: _mapProgram(winner), migrated: false, reason: "SFP_PROGRAM_MIGRATED_CONCURRENTLY" };
  }
  await db.execute(sql`
    INSERT INTO audit_logs (action, entity_type, entity_key, actor_type, actor_id, details)
    VALUES ('sfp_program_migrated_taxonomy_v2', 'sfp_program', ${String(updated.id)}, 'user', ${opts.actorId},
            ${JSON.stringify(sanitizeAuditPayload({
              previousVerticalIds, previousPolicyVersion,
              newVerticalIds, newPolicyVersion: Number(updated.policy_version),
              taxonomyVersion: TAXONOMY_VERSION_V2,
            }))}::jsonb)
  `);
  return { program: _mapProgram(updated), migrated: true };
}

/**
 * Read-only program lookup. Never inserts or converges the program row —
 * safe to call from GET/preview paths. Returns null when no program has been
 * explicitly created yet (via ensureProgram/POST .../program/ensure).
 */
export async function getProgramReadOnly(): Promise<SfpProgram | null> {
  const existing = rows(await db.execute(sql`
    SELECT * FROM sfp_programs WHERE name = ${PROGRAM_NAME} LIMIT 1
  `))[0];
  return existing ? _mapProgram(existing) : null;
}

function _mapProgram(row: any): SfpProgram {
  return {
    id: String(row.id),
    name: String(row.name),
    countyFips: Array.isArray(row.county_fips) ? row.county_fips : JSON.parse(row.county_fips ?? "[]"),
    verticalIds: Array.isArray(row.vertical_ids) ? row.vertical_ids : JSON.parse(row.vertical_ids ?? "[]"),
    maxCohortSize: Number(row.max_cohort_size ?? 100),
    policyVersion: Number(row.policy_version ?? 1),
    taxonomyVersion: Number(row.taxonomy_version) === 2 ? 2 : 1,
    isActive: Boolean(row.is_active),
    recurringEnabled: Boolean(row.recurring_enabled),
    campaignStagingBatchSize: Number((row.schedule_config && (row.schedule_config.campaignStaging ?? row.schedule_config.campaign_staging)) ?? 0),
    activatedAt: row.activated_at ? String(row.activated_at) : null,
    createdAt: String(row.created_at),
    createdBy: String(row.created_by),
  };
}

/** Explicit operator-owned activation. Credentials never activate this program. */
export async function setProgramActivation(input: {
  active: boolean;
  actorId: string;
  recurringEnabled?: boolean;
}): Promise<SfpProgram> {
  const program = await ensureProgram({ createdBy: input.actorId });
  const recurringEnabled = input.active && input.recurringEnabled === true;
  const updated = rows(await db.execute(sql`
    UPDATE sfp_programs
       SET is_active = ${input.active},
           recurring_enabled = ${recurringEnabled},
           activated_at = CASE WHEN ${input.active} THEN NOW() ELSE activated_at END,
           activated_by = CASE WHEN ${input.active} THEN ${input.actorId} ELSE activated_by END
     WHERE id = ${program.id}::uuid
     RETURNING *
  `))[0];
  await db.execute(sql`
    INSERT INTO audit_logs (action, entity_type, entity_key, actor_type, actor_id, details)
    VALUES ('sfp_program_activation_changed', 'sfp_program', ${program.id}, 'user', ${input.actorId},
            ${JSON.stringify(sanitizeAuditPayload({ active: input.active, recurringEnabled, campaignStagingBatchSize: Number(updated?.schedule_config?.campaignStaging ?? 0) }))}::jsonb)
  `);
  return _mapProgram(updated);
}

/**
 * Configure only the recurring campaign-staging boundary. This deliberately
 * does not activate the program or change outbound/channel authority.
 */
export async function setCampaignStagingSchedule(input: {
  recurringEnabled: boolean;
  batchSize: number;
  actorId: string;
}): Promise<SfpProgram> {
  if (!Number.isInteger(input.batchSize) || input.batchSize < 0 || input.batchSize > 25) {
    throw new Error("SFP_CAMPAIGN_STAGING_BATCH_MUST_BE_0_TO_25");
  }
  if (input.recurringEnabled && input.batchSize < 1) {
    throw new Error("SFP_CAMPAIGN_STAGING_REQUIRES_POSITIVE_BATCH");
  }

  return db.transaction(async (tx) => {
    const current = rows(await tx.execute(sql`
      SELECT * FROM sfp_programs WHERE name=${PROGRAM_NAME} FOR UPDATE
    `))[0];
    if (!current) throw new Error("SFP_PROGRAM_NOT_CONFIGURED");
    if (input.recurringEnabled && current.is_active !== true) {
      throw new Error("SFP_PROGRAM_MUST_BE_ACTIVE_FOR_RECURRING_STAGING");
    }
    const updated = rows(await tx.execute(sql`
      UPDATE sfp_programs
         SET recurring_enabled=${input.recurringEnabled},
             schedule_config=jsonb_set(
               COALESCE(schedule_config,'{}'::jsonb),
               '{campaignStaging}', to_jsonb(${input.batchSize}::int), TRUE
             )
       WHERE id=${String(current.id)}::uuid
       RETURNING *
    `))[0];
    await tx.execute(sql`
      INSERT INTO audit_logs (action, entity_type, entity_key, actor_type, actor_id, details)
      VALUES ('sfp_campaign_staging_schedule_changed','sfp_program',${String(current.id)},
              'user',${input.actorId},
              ${JSON.stringify(sanitizeAuditPayload({
                recurringEnabled: input.recurringEnabled,
                campaignStagingBatchSize: input.batchSize,
                programActive: current.is_active === true,
              }))}::jsonb)
    `);
    return _mapProgram(updated);
  });
}

// ── Funnel preview (read-only) ─────────────────────────────────────────────────

export interface SfpFunnelPreview {
  program: SfpProgram;
  funnel: RoiCohortSelection["funnel"];
  topCandidates: Array<{
    businessId: number;
    roiScore: number;
    geographyClass: string;
    geographySource: string;
    vertical: string | null;
    countyFips: string | null;
    eligible: boolean;
    dispositionReason: string;
    contactId?: number;
    contactBusinessLinkDecisionId?: string;
    contactBusinessLinkRevision?: number;
  }>;
  verticalIds: string[];
  countyFips: string[];
  capturedAt: string;
  selectedContactScope?: {
    selectedContactIds: number[];
    resolvedTargets: SfpSelectedContactTarget[];
    maxCohortSize: number;
    snapshotHash: string;
  };
  scopeCapabilities: {
    selectedContactIds: true;
    selectedContactIdsMax: number;
    scopedFreshFreeze: true;
    existingFrozenRunsImmutable: true;
  };
}

export async function previewFunnel(opts: {
  maxPreview?: number;
  programId?: string;
  selectedContactIds?: number[];
} = {}): Promise<SfpFunnelPreview> {
  // Task #1998 round-3 correction (item 4): validate maxPreview INSIDE this
  // service function, not only at the HTTP route (server/routes/lead-ops.ts
  // has its own copy of this same check, but any other caller — a script, a
  // worker, a future route — must not be able to bypass it and reach
  // selectRoiCohort with a malformed cap).
  if (opts.maxPreview !== undefined) {
    if (!Number.isInteger(opts.maxPreview) || opts.maxPreview < 1 || opts.maxPreview > SFP_PROGRAM_MAX_COHORT) {
      throw new Error(`SFP_PREVIEW_CAP_INVALID:maxPreview_must_be_an_integer_between_1_and_${SFP_PROGRAM_MAX_COHORT}:received=${String(opts.maxPreview)}`);
    }
  }
  // Read-only: never converges/creates the program row. Preview must work
  // even while the program is inactive — freeze (not preview) is the gate
  // that requires activation.
  const program = await getProgramReadOnly();
  if (!program) throw new Error("SFP_PROGRAM_NOT_CONFIGURED:create_the_program_via_POST_program_ensure_first");
  const selectedContactIds = normalizeSelectedContactIds(opts.selectedContactIds);
  const maxCohortSize = opts.maxPreview ?? SFP_CANARY_CAP;
  if (selectedContactIds && selectedContactIds.length > maxCohortSize) {
    throw new Error("SFP_SELECTED_CONTACT_TARGET_COUNT_EXCEEDS_COHORT_CAP");
  }
  const selectedTargets = selectedContactIds
    ? await resolveVerifiedSfpContactTargets(selectedContactIds)
    : undefined;
  const result = await selectRoiCohort({
    // In scoped mode, the complete eligible census is retained below so a
    // target is not silently lost merely because it ranks below the general
    // cohort cap. The scope still admits only ordinarily eligible businesses.
    maxCohort: selectedContactIds ? SFP_PROGRAM_MAX_COHORT : maxCohortSize,
    verticalIds: program.verticalIds,
    countyFips: program.countyFips,
    persistScores: false,
    includeGeographyUnresolved: false,
    taxonomyVersion: program.taxonomyVersion,
    policyVersion: program.policyVersion,
  });

  const scopedResult = selectedTargets
    ? scopeRoiSelectionToTargets(result, selectedTargets)
    : result;
  const snapshotHash = selectedTargets
    ? buildSelectedContactScopeSnapshotHash(program, maxCohortSize, selectedTargets, scopedResult.eligible)
    : undefined;
  const targetByBusiness = new Map(selectedTargets?.map((target) => [target.businessId, target]) ?? []);
  return {
    program,
    funnel: scopedResult.funnel,
    topCandidates: scopedResult.eligible.map((c) => ({
      businessId: c.canonicalBusinessId,
      roiScore: c.roiScore,
      geographyClass: c.geographyClass,
      geographySource: c.geographySource,
      vertical: c.vertical,
      countyFips: c.countyFips,
      eligible: c.eligible,
      dispositionReason: c.dispositionReason,
      ...(targetByBusiness.has(c.canonicalBusinessId) ? {
        contactId: targetByBusiness.get(c.canonicalBusinessId)!.contactId,
        contactBusinessLinkDecisionId: targetByBusiness.get(c.canonicalBusinessId)!.linkDecisionId,
        contactBusinessLinkRevision: targetByBusiness.get(c.canonicalBusinessId)!.linkRevision,
      } : {}),
    })),
    verticalIds: scopedResult.verticalIds,
    countyFips: scopedResult.countyFips,
    capturedAt: scopedResult.selectedAt,
    ...(selectedTargets ? {
      selectedContactScope: {
        selectedContactIds: selectedContactIds!,
        resolvedTargets: selectedTargets,
        maxCohortSize,
        snapshotHash: snapshotHash!,
      },
    } : {}),
    scopeCapabilities: {
      selectedContactIds: true,
      selectedContactIdsMax: SFP_SELECTED_CONTACTS_MAX,
      scopedFreshFreeze: true,
      existingFrozenRunsImmutable: true,
    },
  };
}

function scopeRoiSelectionToTargets(
  selection: RoiCohortSelection,
  targets: SfpSelectedContactTarget[],
): RoiCohortSelection {
  const targetBusinessIds = new Set(targets.map((target) => target.businessId));
  const rankedEligible = [
    ...selection.eligible,
    ...selection.excluded.filter((candidate) => candidate.dispositionReason === "excluded:cohort_cap"),
  ];
  const eligibleByBusiness = new Map(rankedEligible.map((candidate) => [candidate.canonicalBusinessId, candidate]));
  for (const target of targets) {
    if (!eligibleByBusiness.has(target.businessId)) {
      const candidate = selection.excluded.find((row) => row.canonicalBusinessId === target.businessId);
      throw new Error(
        `SFP_SELECTED_CONTACT_BUSINESS_NOT_ELIGIBLE:contact=${target.contactId}:business=${target.businessId}:reason=${candidate?.dispositionReason ?? "not_in_canonical_census"}`,
      );
    }
  }
  const eligible = rankedEligible
    .filter((candidate) => targetBusinessIds.has(candidate.canonicalBusinessId))
    .map((candidate) => candidate.dispositionReason === "excluded:cohort_cap"
      ? { ...candidate, eligible: true, dispositionReason: "eligible" }
      : candidate);
  const selectedIds = new Set(eligible.map((candidate) => candidate.canonicalBusinessId));
  const excluded = [
    ...selection.excluded
      .filter((candidate) => !selectedIds.has(candidate.canonicalBusinessId))
      .map((candidate) => candidate.dispositionReason === "excluded:cohort_cap"
        ? { ...candidate, dispositionReason: "excluded:contact_scope" }
        : candidate),
    ...selection.eligible
      .filter((candidate) => !selectedIds.has(candidate.canonicalBusinessId))
      .map((candidate) => ({ ...candidate, eligible: false, dispositionReason: "excluded:contact_scope" })),
  ];
  return { ...selection, eligible, excluded };
}

function cohortCandidateManifest(candidate: RoiCohortSelection["eligible"][number], rank: number) {
  return {
    businessId: candidate.canonicalBusinessId,
    rank,
    roiScore: candidate.roiScore,
    scoreVersion: candidate.scoreVersion,
    dimensions: candidate.dimensions,
    vertical: candidate.vertical,
    countyFips: candidate.countyFips,
    exclusionPolicyVersion: EXCLUSION_POLICY_VERSION,
    geography: candidate.geographyResolution
      ? {
          resolverVersion: candidate.geographyResolution.resolverVersion,
          outcome: candidate.geographyResolution.outcome,
          evidenceClass: candidate.geographyResolution.evidenceClass,
          winningLocationId: candidate.geographyResolution.winningLocationId,
          countyFips: candidate.geographyResolution.countyFips,
        }
      : null,
    classifier: candidate.classifierResult
      ? {
          version: candidate.classifierResult.version,
          outcome: candidate.classifierResult.outcome,
          evidenceHash: candidate.classifierResult.evidenceHash,
          matchedTargetId: candidate.classifierResult.matchedTargetId,
          confidence: candidate.classifierResult.confidence,
        }
      : null,
    phaseAClassificationEvidence: candidate.classificationEvidence ?? null,
  };
}

type SfpContactScopeProgram = Pick<SfpProgram, "id" | "verticalIds" | "countyFips" | "policyVersion" | "taxonomyVersion">;

function selectedContactPolicyVersions(program: SfpContactScopeProgram) {
  return {
    programPolicyVersion: program.policyVersion,
    scoreVersion: ROI_SCORE_VERSION,
    classifierVersion: CLASSIFIER_VERSION,
    geographyResolverVersion: GEOGRAPHY_RESOLVER_VERSION,
    sfpPolicyVersion: SFP_POLICY_VERSION,
    exclusionPolicyVersion: EXCLUSION_POLICY_VERSION,
  };
}

function buildSelectedContactScopeSnapshotHash(
  program: SfpContactScopeProgram,
  maxCohortSize: number,
  targets: SfpSelectedContactTarget[],
  candidates: RoiCohortSelection["eligible"],
): string {
  const policyVersions = selectedContactPolicyVersions(program);
  const configHash = createHash("sha256").update(JSON.stringify({
    verticalIds: [...program.verticalIds].sort(),
    countyFips: [...program.countyFips].sort(),
    policyVersions,
  })).digest("hex");
  const payload = {
    scopeType: "selected_contact_ids",
    selectedContactIds: targets.map((target) => target.contactId).sort((a, b) => a - b),
    resolvedTargets: targets
      .map((target) => ({
        contactId: target.contactId,
        businessId: target.businessId,
        linkDecisionId: target.linkDecisionId,
        linkRevision: target.linkRevision,
      }))
      .sort((a, b) => a.contactId - b.contactId),
    maxCohortSize,
    programId: program.id,
    taxonomyVersion: program.taxonomyVersion,
    policyVersions,
    configHash,
    candidates: candidates.map((candidate, index) => cohortCandidateManifest(candidate, index + 1)),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

// ── Cohort freeze ──────────────────────────────────────────────────────────────

const ZERO_FUNNEL: RoiCohortSelection["funnel"] = {
  totalScanned: 0, southFlorida: 0, outsideGeography: 0, geographyUnresolved: 0,
  inTargetVertical: 0, verticalUnresolved: 0, noVerticalEvidence: 0, explicitNonTarget: 0,
  reviewRequired: 0, verticalConflict: 0, staleEvidence: 0, dbprExcluded: 0, existingCustomer: 0,
  testDemoInternal: 0, suppressed: 0, bouncedInvalidOnly: 0, inactiveEntity: 0,
  eligibleAfterExclusions: 0,
};

/** Canary designation cap — independent of the program's 1-100 cohort cap. */
const SFP_CANARY_CAP = 25;
/** Program-level cohort size cap enforced at this owning layer regardless of caller input. */
const SFP_PROGRAM_MAX_COHORT = 100;

export interface SfpCohortRun {
  id: string;
  programId: string;
  idempotencyKey: string;
  status: string;
  /** Immutable cohort lifecycle — distinct from downstream stage-progress
   *  status (sfp_stage_runs.state). Only 'frozen' with voidedAt/
   *  supersededAt both null is consumable downstream. */
  cohortState: "freezing" | "frozen" | "failed" | "voided" | "superseded";
  cohortSize: number;
  cohortHash: string | null;
  frozenAt: string | null;
  releaseSha: string;
  actorId: string;
  createdAt: string;
  requestHash: string | null;
  configHash: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  supersededAt: string | null;
  supersededByRunId: string | null;
  /** Correction 7: explicit frozen source-snapshot / high-water identity,
   *  captured inside the freeze transaction, distinct from requestHash. */
  sourceSnapshotHash: string | null;
  sourceHighWaterBusinessId: number | null;
  sourceBusinessCount: number | null;
  sourceSnapshotCapturedAt: string | null;
  selectedContactScope?: {
    selectedContactIds: number[];
    resolvedTargets: SfpSelectedContactTarget[];
    previewSnapshotHash: string;
  };
}

function _mapFunnelSnapshot(f: any): RoiCohortSelection["funnel"] {
  return {
    totalScanned: Number(f.total_businesses ?? 0),
    southFlorida: Number(f.south_florida ?? 0),
    outsideGeography: Number(f.outside_geography ?? 0),
    geographyUnresolved: Number(f.geography_unresolved ?? 0),
    inTargetVertical: Number(f.in_target_vertical ?? 0),
    verticalUnresolved: Number(f.vertical_unresolved ?? 0),
    // These finer-grained buckets are not persisted in the frozen-cohort
    // snapshot row (that table predates this breakdown) -- they only exist
    // on a live, freshly-computed RoiCohortSelection. A historical snapshot
    // read back through this mapper reports 0 for each rather than
    // fabricating a split of its single stored vertical_unresolved total.
    noVerticalEvidence: 0, explicitNonTarget: 0, reviewRequired: 0, verticalConflict: 0, staleEvidence: 0,
    dbprExcluded: Number(f.dbpr_excluded ?? 0),
    existingCustomer: Number(f.existing_customer ?? 0),
    testDemoInternal: Number(f.test_demo_internal ?? 0),
    suppressed: Number(f.suppressed ?? 0),
    bouncedInvalidOnly: Number(f.bounced_invalid_only ?? 0),
    inactiveEntity: Number(f.inactive_entity ?? 0),
    eligibleAfterExclusions: Number(f.ready_for_validation ?? f.outreach_eligible ?? 0),
  };
}

/**
 * Freeze a cohort against ONE consistent snapshot (REPEATABLE READ), inside
 * one atomic transaction, with keyset-paginated scanning (see
 * roi-cohort-selector.ts), program-cap enforcement (1-100), a full-manifest
 * cohort hash, a terminal decision ledger row per scanned business, a
 * deterministic canary designation, and program+key+request-hash idempotency
 * semantics:
 *   - same idempotency key + same request payload → replay the stored run (200)
 *   - same idempotency key + different request payload → reject (409-mapped error)
 *   - a prior 'frozen' or 'failed' run under this key is NEVER reopened
 *   - concurrent callers with the same key are serialized by a Postgres
 *     advisory transaction lock keyed on the idempotency key, so they
 *     produce exactly one result
 */
export async function freezeCohort(opts: {
  idempotencyKey: string;
  actorId: string;
  maxCohortSize?: number;
  releaseSha?: string;
  selectedContactIds?: number[];
  previewSnapshotHash?: string;
  /**
   * Correction 3: test-only fault-injection seam. Never set by production
   * callers (no route/UI path threads this through). When provided, it is
   * invoked at defined checkpoints inside the freeze transaction
   * ("after_members_inserted", "after_decisions_inserted") so the
   * disposable certification suite can prove a genuine mid-transaction
   * failure — thrown from real code executing inside the real transaction,
   * not a simulated/mocked error — rolls back every write the transaction
   * made (members, decisions, snapshot, run-row state) and leaves only the
   * single durable failed-run row this function's own catch block writes.
   */
  _testFaultInjector?: (stage: "after_members_inserted" | "after_decisions_inserted") => void;
}): Promise<{ run: SfpCohortRun; newlyFrozen: boolean; funnel: RoiCohortSelection["funnel"] }> {
  // Round-2 correction: same-idempotency-key concurrent freeze race.
  //
  // The prior design acquired `pg_advisory_xact_lock` as the FIRST statement
  // inside the very REPEATABLE READ transaction that also did the existing-
  // row lookup. In Postgres, a REPEATABLE READ transaction's snapshot is
  // fixed at the time its first statement begins executing — which happens
  // BEFORE that statement's own wait for the advisory lock resolves. So a
  // caller B that started waiting for the lock while caller A was still
  // mid-freeze had already fixed a snapshot that predates A's commit. Once
  // A committed and released the lock, B would acquire it, but B's OWN
  // snapshot still could not see A's newly frozen row — B would then treat
  // the idempotency key as unclaimed and attempt a duplicate freeze,
  // failing on the row's unique idempotency_key constraint (or worse,
  // racing to insert distinguishable member sets in versions without that
  // constraint).
  //
  // Fix: serialize on a SESSION-level advisory lock held on a dedicated
  // physical connection, acquired and released OUTSIDE the REPEATABLE READ
  // transaction. Session-level `pg_advisory_lock` is a cluster-global lock
  // keyed by its argument, not tied to any one transaction, so caller B's
  // lock acquisition only completes after caller A's session releases it —
  // which happens only after A's transaction has already committed. B's
  // REPEATABLE READ transaction (and therefore its snapshot) is only opened
  // AFTER B's lock acquisition succeeds, so B is guaranteed to see A's
  // committed row. A dedicated `pool.connect()` client (not a pooled
  // drizzle `db.transaction()`) is required because the acquire/release
  // pair must run on the exact same physical connection.
  const lockKeyClient = await pool.connect();
  try {
    await lockKeyClient.query("SELECT pg_advisory_lock(hashtext($1))", [opts.idempotencyKey]);
    try {
      return await freezeCohortLocked(opts);
    } finally {
      // Always release from the same connection that acquired it, even if
      // the freeze attempt threw — an unreleased session lock would
      // permanently wedge every future freeze attempt for this key.
      await lockKeyClient.query("SELECT pg_advisory_unlock(hashtext($1))", [opts.idempotencyKey]);
    }
  } finally {
    lockKeyClient.release();
  }
}

async function freezeCohortLocked(opts: {
  idempotencyKey: string;
  actorId: string;
  maxCohortSize?: number;
  releaseSha?: string;
  selectedContactIds?: number[];
  previewSnapshotHash?: string;
  _testFaultInjector?: (stage: "after_members_inserted" | "after_decisions_inserted") => void;
}): Promise<{ run: SfpCohortRun; newlyFrozen: boolean; funnel: RoiCohortSelection["funnel"] }> {
  const program = await ensureProgram();
  // Task #1998 round-3 correction (item 4): validate the caller-supplied
  // cohort cap INSIDE the service layer itself, not only at the HTTP route.
  // The old Math.max(1, Math.min(100, opts.maxCohortSize ?? ...)) silently
  // coerced invalid input (NaN, fractional, negative, > 100) into NaN or a
  // seemingly-valid clamped number instead of rejecting it outright — a
  // non-HTTP caller (a worker, a script, a future route that forgets its
  // own validation) would never be told its request was malformed.
  if (opts.maxCohortSize !== undefined) {
    if (!Number.isInteger(opts.maxCohortSize) || opts.maxCohortSize < 1 || opts.maxCohortSize > SFP_PROGRAM_MAX_COHORT) {
      throw stableError(`SFP_COHORT_CAP_INVALID:maxCohortSize_must_be_an_integer_between_1_and_${SFP_PROGRAM_MAX_COHORT}:received=${String(opts.maxCohortSize)}`);
    }
  }
  const selectedContactIds = normalizeSelectedContactIds(opts.selectedContactIds);
  const maxCohortSize = Math.min(
    SFP_PROGRAM_MAX_COHORT,
    opts.maxCohortSize ?? (selectedContactIds ? SFP_CANARY_CAP : program.maxCohortSize),
  );
  if (selectedContactIds && selectedContactIds.length > maxCohortSize) {
    throw stableError("SFP_SELECTED_CONTACT_TARGET_COUNT_EXCEEDS_COHORT_CAP");
  }
  if (selectedContactIds && !/^[a-f0-9]{64}$/i.test(String(opts.previewSnapshotHash ?? ""))) {
    throw stableError("SFP_SELECTED_CONTACT_PREVIEW_SNAPSHOT_HASH_REQUIRED");
  }

  const requestPayload = {
    programId: program.id,
    verticalIds: [...program.verticalIds].sort(),
    countyFips: [...program.countyFips].sort(),
    maxCohortSize,
    ...(selectedContactIds ? {
      selectedContactIds,
      previewSnapshotHash: opts.previewSnapshotHash,
    } : {}),
  };
  const requestHash = createHash("sha256").update(JSON.stringify(requestPayload)).digest("hex");
  // Real component versions (VFC-03): every algorithm that contributes to
  // cohort admission/scoring is versioned independently so a change to any
  // one of them (classifier taxonomy, geography resolver tiebreak, ROI
  // scoring formula, or the program's own policy) is visible in the frozen
  // manifest instead of being hidden behind a single hardcoded "1".
  const policyVersions = {
    programPolicyVersion: program.policyVersion,
    scoreVersion: ROI_SCORE_VERSION,
    classifierVersion: CLASSIFIER_VERSION,
    geographyResolverVersion: GEOGRAPHY_RESOLVER_VERSION,
    sfpPolicyVersion: SFP_POLICY_VERSION,
    exclusionPolicyVersion: EXCLUSION_POLICY_VERSION,
  };
  const configHash = createHash("sha256").update(JSON.stringify({
    verticalIds: requestPayload.verticalIds, countyFips: requestPayload.countyFips, policyVersions,
  })).digest("hex");
  // Pre-generated so a mid-freeze failure can be persisted durably (VFC-08)
  // even when the transaction that would have inserted this row as
  // 'freezing' never commits — see the catch block below.
  const preGeneratedRunId = randomUUID();

  try {
    return await db.transaction(async (tx) => { return freezeCohortTx(
      tx,
      { ...opts, selectedContactIds },
      program,
      maxCohortSize,
      requestPayload,
      requestHash,
      policyVersions,
      configHash,
      preGeneratedRunId,
      opts._testFaultInjector,
    ); });
  } catch (err) {
    // Correction 2: expected/stable control-flow outcomes (idempotent
    // payload mismatch, a key that already failed, a key pinned to a
    // terminal voided/superseded run) are NOT new freeze failures — the
    // existing row for this idempotency_key already durably reflects the
    // truth. Attempting a failure-persistence INSERT for one of these would
    // collide with that row's own unique idempotency_key constraint and
    // replace this exact, stable error with a generic
    // SFP_FREEZE_FAILURE_PERSISTENCE_FAILED, masking it. Detected via a
    // structured domain type (instanceof), never fragile message sniffing.
    if (err instanceof SfpStableControlFlowError) {
      throw err;
    }

    // Genuine new-attempt failure. The transaction above has already been
    // rolled back and its connection released by drizzle's db.transaction()
    // wrapper by the time this catch runs — issuing the durable failure
    // write only now (never from inside the still-open failing transaction)
    // avoids a self-deadlock: an INSERT on a second connection targeting a
    // row an uncommitted transaction on the first connection is still
    // holding must wait for that row's commit/rollback to resolve
    // visibility, which never happens if the first connection is itself
    // blocked awaiting this INSERT to finish.
    //
    // ON CONFLICT targets idempotency_key (the actual unique constraint on
    // this table), not id: a retry of a crashed 'freezing' row reuses that
    // row's OWN id inside freezeCohortTx, which differs from this call's
    // freshly generated preGeneratedRunId. Conflicting on id would then miss
    // the existing row entirely and attempt a second INSERT with the same
    // idempotency_key, which itself raises a duplicate-key error and would
    // wrongly fall into the persist-failure branch below for a case that
    // isn't a persistence failure at all. Conflicting on idempotency_key
    // instead correctly updates whichever row (existing 'freezing' row, or
    // none) already owns this key, leaving its original id untouched:
    //   - No existing row for this key: this INSERT creates it fresh.
    //   - An existing 'freezing' row (a prior crashed attempt) for this key:
    //     the UPDATE branch marks THAT row 'failed' with this error.
    //   - Either way, exactly one durable failed row ends up owning this key.
    // The WHERE clause guards against ever downgrading a run that reached a
    // terminal frozen/voided/superseded state before this failure.
    await db.execute(sql`
      INSERT INTO sfp_cohort_runs
        (id, program_id, idempotency_key, status, cohort_state, actor_id, release_sha,
         request_hash, config_hash, request_payload, policy_versions, error_detail)
      VALUES (${preGeneratedRunId}::uuid, ${program.id}::uuid, ${opts.idempotencyKey}, 'error', 'failed',
              ${opts.actorId}, ${opts.releaseSha ?? process.env.RELEASE_SHA ?? ""},
              ${requestHash}, ${configHash}, ${JSON.stringify(requestPayload)}::jsonb,
              ${JSON.stringify(policyVersions)}::jsonb, ${(err as Error).message})
      ON CONFLICT (idempotency_key) DO UPDATE SET
        status = 'error', cohort_state = 'failed', error_detail = EXCLUDED.error_detail
      WHERE sfp_cohort_runs.cohort_state NOT IN ('frozen', 'voided', 'superseded')
    `).catch((persistErr) => {
      // If even the durable failure write fails (e.g. DB unreachable), do
      // not swallow it silently — surface both errors so an operator sees
      // the freeze failed AND its failure record could not be saved.
      throw new Error(`SFP_FREEZE_FAILURE_PERSISTENCE_FAILED:${String((persistErr as Error).message)}:original_error=${(err as Error).message}`);
    });
    throw err;
  }
}

async function freezeCohortTx(
  tx: any,
  opts: {
    idempotencyKey: string;
    actorId: string;
    maxCohortSize?: number;
    releaseSha?: string;
    selectedContactIds?: number[];
    previewSnapshotHash?: string;
  },
  program: { id: string; verticalIds: string[]; countyFips: string[]; maxCohortSize: number; policyVersion: number; taxonomyVersion: 1 | 2 },
  maxCohortSize: number,
  requestPayload: { programId: string; verticalIds: string[]; countyFips: string[]; maxCohortSize: number },
  requestHash: string,
  policyVersions: { programPolicyVersion: number; scoreVersion: number; classifierVersion: number; geographyResolverVersion: number; sfpPolicyVersion: number },
  configHash: string,
  preGeneratedRunId: string,
  _testFaultInjector?: (stage: "after_members_inserted" | "after_decisions_inserted") => void,
): Promise<{ run: SfpCohortRun; newlyFrozen: boolean; funnel: RoiCohortSelection["funnel"] }> {
    // One consistent snapshot for the whole freeze attempt. Serialization
    // across concurrent same-idempotency-key callers is already handled by
    // the SESSION-level pg_advisory_lock acquired on a dedicated connection
    // in freezeCohort() before this transaction ever opens (see the Round-2
    // correction comment there). Taking a SECOND, transaction-scoped
    // pg_advisory_xact_lock on the SAME key here would try to acquire the
    // same cluster-global lock ID from a different physical connection than
    // the one already holding it for the whole duration of this call —
    // deadlocking against itself, not against a genuine concurrent caller.
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);

    const existing = rows(await tx.execute(sql`
      SELECT * FROM sfp_cohort_runs WHERE idempotency_key = ${opts.idempotencyKey} LIMIT 1
    `))[0];

    if (existing) {
      if (existing.cohort_state === "frozen") {
        if (String(existing.request_hash) === requestHash) {
          const snap = rows(await tx.execute(sql`
            SELECT * FROM sfp_funnel_snapshots WHERE cohort_run_id = ${String(existing.id)}::uuid LIMIT 1
          `))[0];
          return { run: _mapRun(existing), newlyFrozen: false, funnel: snap ? _mapFunnelSnapshot(snap) : ZERO_FUNNEL };
        }
        throw stableError("SFP_IDEMPOTENCY_KEY_PAYLOAD_MISMATCH:same_key_different_request_use_a_new_idempotency_key");
      }
      if (existing.cohort_state === "failed") {
        // Never reopen a prior failed run — the plan requires a genuinely
        // new attempt (new idempotency key) rather than silently retrying
        // in place, so failure history stays truthful and inspectable.
        throw stableError(`SFP_COHORT_RUN_PREVIOUSLY_FAILED:${String(existing.error_detail ?? "unknown")}:use_a_new_idempotency_key_to_retry`);
      }
      if (existing.cohort_state === "voided" || existing.cohort_state === "superseded") {
        throw stableError(`SFP_COHORT_RUN_TERMINAL_LIFECYCLE:${String(existing.cohort_state)}:use_a_new_idempotency_key`);
      }
      // cohort_state === 'freezing' here means a previous attempt crashed
      // mid-transaction without committing (its INSERT never became
      // visible) — under the advisory lock no other transaction could have
      // been mid-flight concurrently, so it is safe to redo deterministically.
    }

    const runRow = (existing ?? rows(await tx.execute(sql`
      INSERT INTO sfp_cohort_runs
        (id, program_id, idempotency_key, status, cohort_state, actor_id, release_sha,
         request_hash, config_hash, request_payload, policy_versions)
      VALUES (${preGeneratedRunId}::uuid, ${program.id}::uuid, ${opts.idempotencyKey}, 'freezing', 'freezing',
              ${opts.actorId}, ${opts.releaseSha ?? process.env.RELEASE_SHA ?? ""},
              ${requestHash}, ${configHash}, ${JSON.stringify(requestPayload)}::jsonb,
              ${JSON.stringify(policyVersions)}::jsonb)
      RETURNING *
    `))[0]);
    const runId = String(runRow.id);

      // Correction 7: capture an explicit source snapshot / high-water
      // identity inside this same REPEATABLE READ transaction, before the
      // scan runs, so it describes exactly the canonical-business universe
      // selectRoiCohort is about to observe. Deliberately NOT folded into
      // requestHash (which drives idempotent replay matching) — the source
      // snapshot changes on every subsequent insert to `businesses`, but the
      // same logical freeze request must still replay identically.
      const snapRow = rows(await tx.execute(sql`
        SELECT
          txid_current() AS txid,
          txid_current_snapshot()::text AS txn_snapshot,
          (SELECT MAX(id) FROM businesses WHERE record_class = 'canonical') AS high_water_id,
          (SELECT COUNT(*)::int FROM businesses WHERE record_class = 'canonical') AS biz_count
      `))[0];
      const sourceHighWaterBusinessId = snapRow?.high_water_id != null ? Number(snapRow.high_water_id) : null;
      const sourceBusinessCount = Number(snapRow?.biz_count ?? 0);
      const sourceTxid = snapRow?.txid != null ? String(snapRow.txid) : null;
      const sourceSnapshotCapturedAt = new Date().toISOString();
      const sourceSnapshotHash = createHash("sha256").update(JSON.stringify({
        txnSnapshot: snapRow?.txn_snapshot ?? null,
        highWaterBusinessId: sourceHighWaterBusinessId,
        businessCount: sourceBusinessCount,
        policyVersions,
        capturedAt: sourceSnapshotCapturedAt,
      })).digest("hex");

      // ROI selection runs against this same transaction handle, so the
      // scan, scoring, and member insert all observe one consistent
      // snapshot rather than racing live writes between steps.
      const selectedTargets = opts.selectedContactIds
        ? await resolveVerifiedSfpContactTargets(opts.selectedContactIds, tx)
        : undefined;
      const rawSelection = await selectRoiCohort({
        maxCohort: selectedTargets ? SFP_PROGRAM_MAX_COHORT : maxCohortSize,
        verticalIds: program.verticalIds,
        countyFips: program.countyFips,
        persistScores: true,
        actorId: opts.actorId,
        executor: tx,
        taxonomyVersion: program.taxonomyVersion,
        policyVersion: program.policyVersion,
      });
      const result = selectedTargets
        ? scopeRoiSelectionToTargets(rawSelection, selectedTargets)
        : rawSelection;
      if (selectedTargets) {
        const currentScopeHash = buildSelectedContactScopeSnapshotHash(
          program,
          maxCohortSize,
          selectedTargets,
          result.eligible,
        );
        if (currentScopeHash !== opts.previewSnapshotHash) {
          throw stableError("SFP_SELECTED_CONTACT_SCOPE_PREVIEW_STALE:links_or_eligibility_changed_reissue_preview");
        }
        await tx.execute(sql`
          UPDATE sfp_cohort_runs
             SET request_payload=request_payload || ${JSON.stringify({
               selectedContactTargets: selectedTargets,
             })}::jsonb
           WHERE id=${runId}::uuid
        `);
      }

      if (result.eligible.length === 0) {
        const f = result.funnel;
        let zeroReason = "no_eligible_businesses_after_exclusions";
        if (f.totalScanned === 0) zeroReason = "no_businesses_in_database";
        else if (f.southFlorida === 0) zeroReason = "no_south_florida_businesses_found:check_geography_fields";
        else if (f.inTargetVertical === 0) zeroReason = `no_businesses_in_target_verticals:${result.verticalIds.join(",")}`;
        else if (f.dbprExcluded > 0) zeroReason = `all_eligible_businesses_dbpr_excluded:count=${f.dbprExcluded}`;
        else if (f.existingCustomer > 0) zeroReason = `all_eligible_businesses_existing_customer:count=${f.existingCustomer}`;
        else if (f.eligibleAfterExclusions === 0) zeroReason = `zero_after_all_exclusions:scanned=${f.totalScanned},sf=${f.southFlorida},vertical=${f.inTargetVertical}`;
        throw new Error(`COHORT_CENSUS_INSUFFICIENT:${zeroReason}`);
      }

      // Insert cohort members with a stable selection_rank (roi_score DESC,
      // canonical_business_id ASC — see selectRoiCohort's sort) and a
      // deterministic canary designation on the first SFP_CANARY_CAP ranked
      // members, independent of the program's cohort-size cap.
      let rank = 0;
      for (const c of result.eligible) {
        rank++;
        const isCanary = rank <= SFP_CANARY_CAP;
        // Persist the EXACT classifier/geography evidence that admitted this
        // member (Correction 1) — a selected member always has both
        // classifierResult and geographyResolution populated (selectRoiCohort
        // only reaches the eligible array after both resolve favorably), so
        // neither is expected to be null here.
        const cls = c.classifierResult;
        const geo = c.geographyResolution;
        await tx.execute(sql`
          INSERT INTO sfp_cohort_members
            (cohort_run_id, business_id, roi_score, geography_class, geography_source,
             county_fips, vertical, exclusion_reason, selection_rank, is_canary,
             classifier_version, classifier_outcome, classifier_confidence, classifier_matched_target,
             classifier_reasons, classifier_evidence_hash,
             geography_resolver_version, geography_outcome, geography_location_id, geography_reasons)
          VALUES (${runId}::uuid, ${c.canonicalBusinessId}, ${c.roiScore},
                  ${c.geographyClass}, ${c.geographySource}, ${c.countyFips}, ${c.vertical}, ${null},
                  ${rank}, ${isCanary},
                  ${cls?.version ?? null}, ${cls?.outcome ?? null}, ${cls?.confidence ?? null}, ${cls?.matchedTargetId ?? null},
                  ${cls ? JSON.stringify(cls.reasons) : null}::jsonb, ${cls?.evidenceHash ?? null},
                  ${geo?.resolverVersion ?? null}, ${geo?.outcome ?? null}, ${geo?.winningLocationId ?? null},
                  ${geo ? JSON.stringify(geo.reasons) : null}::jsonb)
        `);
      }

      // Correction 3 fault-injection checkpoint: fires only when a test
      // explicitly supplies _testFaultInjector. A throw here happens inside
      // this same open transaction, after real member rows have already
      // been written to it (but not committed), proving the transaction's
      // rollback — not application-level cleanup — is what removes them.
      _testFaultInjector?.("after_members_inserted");

      // Terminal decision ledger: exactly one row per scanned business
      // (both selected and excluded), so sum(all dispositions) reconciles
      // exactly against total scanned canonical businesses.
      const allDecided = [...result.eligible, ...result.excluded];
      const selectedIds = new Set(result.eligible.map((c) => c.canonicalBusinessId));
      const decisionValues: SQL[] = [];
      // One multi-row statement per bounded chunk keeps the immutable ledger
      // complete without a separate database round trip for every excluded
      // business. 100 rows x 33 columns stays below PostgreSQL's parameter cap.
      const flushDecisions = async () => {
        if (decisionValues.length === 0) return;
        await tx.execute(sql`
          INSERT INTO sfp_cohort_decisions
            (cohort_run_id, business_id, disposition, disposition_detail, suppression_scope,
             suppression_subject_hash, suppression_authority, suppression_reason_code,
             suppression_evidence_ref, suppression_channel, suppression_subjects,
             suppression_business_wide_rule_applied,
             geography_class, geography_source, vertical, roi_score, selected,
             classifier_version, classifier_outcome, classifier_confidence, classifier_matched_target,
             classifier_reasons, classifier_evidence_hash,
             geography_resolver_version, geography_outcome, geography_location_id, geography_reasons,
             classification_evidence_id, classification_policy_version, classification_evidence_hash,
             classification_model_version, classification_prompt_version, classification_classifier_version)
          VALUES ${sql.join(decisionValues, sql`, `)}
          ON CONFLICT (cohort_run_id, business_id) DO NOTHING
        `);
        decisionValues.length = 0;
      };
      for (const c of allDecided) {
        const isSelected = selectedIds.has(c.canonicalBusinessId);
        const disposition = c.dispositionReason.startsWith("excluded:")
          ? c.dispositionReason.split(":")[1]
          : (isSelected ? "selected" : "excluded:cohort_cap");
        // Correction 5: subject-aware suppression scope/subject evidence,
        // taken directly from the structured evidence the selector computed
        // (roi-cohort-selector.ts) — never collapse every suppression to a
        // blanket "business" scope, which would silently broaden an email-
        // or contact-scoped suppression to the whole business in this audit
        // trail. Covers both suppressed and bounced/invalid-only exclusions.
        const suppressionScope = c.suppressionEvidence?.scope ?? (disposition === "suppressed" || disposition === "bounced_invalid_only" ? "business" : null);
        const suppressionSubjectHash = c.suppressionEvidence?.subjectHash ?? null;
        // Task #1998 round-3 correction (item 3): persist the FULL structured
        // per-subject evidence — every determining contact, its real
        // authority/reasonCode/evidenceRef/channel — never collapsed to one
        // sampled subject or a scope inferred from email-column presence.
        const supEv = c.suppressionEvidence;
        const firstSubject = supEv?.subjects?.[0] ?? null;
        const suppressionAuthority = firstSubject?.authority ?? null;
        const suppressionReasonCode = firstSubject?.reasonCode ?? supEv?.reason ?? null;
        const suppressionEvidenceRef = firstSubject?.evidenceRef ?? null;
        const suppressionChannel = firstSubject?.channel ?? null;
        const suppressionSubjectsJson = supEv?.subjects && supEv.subjects.length > 0 ? JSON.stringify(supEv.subjects) : null;
        const suppressionBusinessWideRuleApplied = supEv?.businessWideRuleApplied ?? false;
        // Correction 1: persist the exact classifier/geography evidence that
        // decided this business's disposition (selected or excluded) — not
        // just for admitted members. A business excluded on geography or
        // vertical grounds still carries a real classifier/geography
        // resolution explaining WHY.
        const cls = c.classifierResult;
        const geo = c.geographyResolution;
        // Task #1999 (Architecture correction 1 / C1): pin the latest admissible
        // pre-cohort classification evidence row for this business, under the
        // program's active SFP_POLICY_VERSION, into this immutable decision row.
        // A later classification run inserting a NEW sfp_classification_evidence
        // row for this same business can never retroactively change what this
        // already-frozen decision meant, because this FK points at one specific
        // evidence row id, not at "the latest row for this business" at read time.
        // Best-effort: null when no current-policy evidence exists. The selector
        // already loaded the complete current evidence map under this same
        // REPEATABLE READ snapshot, so a per-business fallback query would be
        // redundant and turn a 33k-row freeze into 33k extra round trips.
        const classificationEvidenceId = c.classificationEvidence?.id ?? null;
        const classificationPolicyVersion = c.classificationEvidence?.policyVersion ?? null;
        decisionValues.push(sql`(${runId}::uuid, ${c.canonicalBusinessId}, ${disposition}, ${c.dispositionReason},
                  ${suppressionScope}, ${suppressionSubjectHash}, ${suppressionAuthority}, ${suppressionReasonCode},
                  ${suppressionEvidenceRef}, ${suppressionChannel}, ${suppressionSubjectsJson}::jsonb,
                  ${suppressionBusinessWideRuleApplied},
                  ${c.geographyClass}, ${c.geographySource}, ${c.vertical},
                  ${c.roiScore}, ${isSelected},
                  ${cls?.version ?? null}, ${cls?.outcome ?? null}, ${cls?.confidence ?? null}, ${cls?.matchedTargetId ?? null},
                  ${cls ? JSON.stringify(cls.reasons) : null}::jsonb, ${cls?.evidenceHash ?? null},
                  ${geo?.resolverVersion ?? null}, ${geo?.outcome ?? null}, ${geo?.winningLocationId ?? null},
                  ${geo ? JSON.stringify(geo.reasons) : null}::jsonb,
                   ${classificationEvidenceId}::uuid, ${classificationPolicyVersion},
                   ${c.classificationEvidence?.evidenceHash ?? null},${c.classificationEvidence?.modelVersion ?? null},
                   ${c.classificationEvidence?.promptVersion ?? null},${c.classificationEvidence?.classifierVersion ?? null})`);
        if (decisionValues.length === 100) await flushDecisions();
      }
      await flushDecisions();

      // Correction 3 second fault-injection checkpoint: after the full
      // decision ledger has been written (but still inside the open,
      // uncommitted transaction). Lets the certification suite prove
      // rollback removes BOTH member and decision rows together, not just
      // whichever table happened to be written first.
      _testFaultInjector?.("after_decisions_inserted");

      // Full-manifest cohort hash (VFC-04): covers every field that
      // determines this cohort's admitted membership and how it was scored
      // — identity, rank, ROI score, full score dimensions, geography
      // resolution (version/outcome/winning location/county), classifier
      // resolution (version/outcome/matched target/confidence/evidence
      // hash), and the exclusion-policy version that governed which
      // businesses could even reach this membership set — not just a
      // sorted businessId:rank:roiScore triple. Any change to ranking,
      // scoring, geography resolution, vertical classification, or the
      // exclusion rules for the same membership set changes this hash.
      const memberManifest = result.eligible.map((candidate, index) =>
        cohortCandidateManifest(candidate, index + 1));
      const manifest = opts.selectedContactIds
        ? JSON.stringify({
            scopeType: "selected_contact_ids",
            selectedContactIds: opts.selectedContactIds,
            resolvedTargets: selectedTargets,
            previewSnapshotHash: opts.previewSnapshotHash,
            members: memberManifest,
          })
        : JSON.stringify(memberManifest);
      const cohortHash = createHash("sha256").update(manifest).digest("hex");

      // Round-2 correction: the funnel snapshot MUST be written while the
      // run is still 'freezing' — i.e. before the run row itself flips to
      // 'frozen' — because migration 0283 adds a BEFORE INSERT/UPDATE/DELETE
      // immutability trigger on sfp_funnel_snapshots that rejects any write
      // once its owning run's cohort_state is frozen/voided/superseded.
      // Writing the snapshot first (matching how members/decisions are
      // already written before the state flip) keeps this legitimate,
      // one-time write inside the still-open "freezing" window.
      const f = result.funnel;
      await tx.execute(sql`
        INSERT INTO sfp_funnel_snapshots
          (cohort_run_id, total_businesses, south_florida, outside_geography,
           geography_unresolved, in_target_vertical, vertical_unresolved,
           dbpr_excluded, suppressed, bounced_invalid_only, existing_customer, test_demo_internal, inactive_entity,
           outreach_eligible, selected_frozen)
        VALUES (${runId}::uuid, ${f.totalScanned}, ${f.southFlorida}, ${f.outsideGeography},
                ${f.geographyUnresolved}, ${f.inTargetVertical}, ${f.verticalUnresolved},
                ${f.dbprExcluded}, ${f.suppressed}, ${f.bouncedInvalidOnly}, ${f.existingCustomer}, ${f.testDemoInternal}, ${f.inactiveEntity},
                ${f.eligibleAfterExclusions}, ${result.eligible.length})
        ON CONFLICT (cohort_run_id) DO UPDATE SET
          total_businesses = EXCLUDED.total_businesses,
          south_florida = EXCLUDED.south_florida,
          outside_geography = EXCLUDED.outside_geography,
          geography_unresolved = EXCLUDED.geography_unresolved,
          in_target_vertical = EXCLUDED.in_target_vertical,
          vertical_unresolved = EXCLUDED.vertical_unresolved,
          dbpr_excluded = EXCLUDED.dbpr_excluded,
          suppressed = EXCLUDED.suppressed,
          bounced_invalid_only = EXCLUDED.bounced_invalid_only,
          existing_customer = EXCLUDED.existing_customer,
          test_demo_internal = EXCLUDED.test_demo_internal,
          inactive_entity = EXCLUDED.inactive_entity,
          outreach_eligible = EXCLUDED.outreach_eligible,
          selected_frozen = EXCLUDED.selected_frozen
      `);

      const updatedRun = rows(await tx.execute(sql`
        UPDATE sfp_cohort_runs
        SET status = 'frozen', cohort_state = 'frozen', cohort_size = ${result.eligible.length},
            cohort_hash = ${cohortHash}, frozen_at = NOW(),
            source_snapshot_hash = ${sourceSnapshotHash},
            source_high_water_business_id = ${sourceHighWaterBusinessId},
            source_business_count = ${sourceBusinessCount},
            source_txid = ${sourceTxid}::bigint,
            source_snapshot_captured_at = ${sourceSnapshotCapturedAt}::timestamptz
        WHERE id = ${runId}::uuid
        RETURNING *
      `))[0];

      return { run: _mapRun(updatedRun), newlyFrozen: true, funnel: result.funnel };
}

/**
 * Void a frozen cohort run: appends immutable lifecycle evidence
 * (voided_at/voided_by/void_reason) and blocks it from future downstream
 * admission. Never rewrites or deletes the frozen manifest, members, or
 * decisions — that data remains queryable as history.
 */
export async function voidCohortRun(opts: {
  cohortRunId: string;
  actorId: string;
  reason: string;
}): Promise<SfpCohortRun> {
  // Round-2 correction: single transaction with a row lock, so a concurrent
  // void/supersede attempt against the same run cannot both read 'frozen'
  // and both proceed to update it — the second waits for the lock, then
  // re-reads the now-terminal state and is rejected instead of silently
  // overwriting the first transition's lifecycle evidence.
  return await db.transaction(async (tx) => {
    const run = rows(await tx.execute(sql`
      SELECT * FROM sfp_cohort_runs WHERE id = ${opts.cohortRunId}::uuid FOR UPDATE
    `))[0];
    if (!run) throw new Error("SFP_COHORT_RUN_NOT_FOUND");
    if (run.cohort_state !== "frozen") throw new Error(`SFP_COHORT_VOID_REJECTED:not_frozen:current_state=${run.cohort_state}`);

    const updated = rows(await tx.execute(sql`
      UPDATE sfp_cohort_runs
      SET cohort_state = 'voided', voided_at = NOW(), voided_by = ${opts.actorId}, void_reason = ${opts.reason}
      WHERE id = ${opts.cohortRunId}::uuid
      RETURNING *
    `))[0];
    await tx.execute(sql`
      INSERT INTO audit_logs (action, entity_type, entity_key, actor_type, actor_id, details)
      VALUES ('sfp_cohort_run_voided', 'sfp_cohort_run', ${opts.cohortRunId}, 'user', ${opts.actorId},
              ${JSON.stringify(sanitizeAuditPayload({ reason: opts.reason }))}::jsonb)
    `);
    return _mapRun(updated);
  });
}

/**
 * Supersede a frozen cohort run with a newly frozen replacement: appends
 * immutable lifecycle evidence (superseded_at/superseded_by_run_id) without
 * rewriting the original frozen manifest.
 */
export async function supersedeCohortRun(opts: {
  cohortRunId: string;
  supersededByRunId: string;
  actorId: string;
}): Promise<SfpCohortRun> {
  if (opts.cohortRunId === opts.supersededByRunId) {
    throw new Error("SFP_SUPERSEDE_REJECTED:self_supersession_not_allowed");
  }
  // Round-2 correction: single transaction, both rows locked in a stable
  // (id-ordered) order to avoid deadlocking against a concurrent supersede
  // touching the same two runs in the opposite direction, and the
  // replacement's 'frozen' state is revalidated INSIDE this same locked
  // transaction — not from an earlier, separately-committed read — so a
  // replacement that itself got voided/superseded between the caller's
  // check and this call can never be accepted.
  const [firstId, secondId] = [opts.cohortRunId, opts.supersededByRunId].sort();
  return await db.transaction(async (tx) => {
    const lockedById = new Map<string, any>();
    for (const id of [firstId, secondId]) {
      const row = rows(await tx.execute(sql`
        SELECT * FROM sfp_cohort_runs WHERE id = ${id}::uuid FOR UPDATE
      `))[0];
      if (row) lockedById.set(id, row);
    }
    const run = lockedById.get(opts.cohortRunId);
    const replacement = lockedById.get(opts.supersededByRunId);
    if (!run) throw new Error("SFP_COHORT_RUN_NOT_FOUND");
    if (!replacement) throw new Error("SFP_COHORT_RUN_NOT_FOUND:replacement");
    // Task #1998 round-3 correction (item 5): a replacement run belonging to
    // a DIFFERENT program must never be accepted as the supersession of this
    // run — that would let one program's cohort silently replace another
    // program's history, corrupting per-program lineage. Verified inside
    // this same locked transaction, using the just-locked rows (not an
    // earlier, separately-committed read), for the same reason the
    // replacement's lifecycle state is revalidated here.
    if (replacement.program_id !== run.program_id) {
      throw new Error("SFP_SUPERSEDE_REJECTED:cross_program_replacement_not_allowed");
    }
    if (replacement.cohort_state !== "frozen") throw new Error("SFP_SUPERSEDE_REJECTED:replacement_not_frozen");
    if (run.cohort_state !== "frozen") throw new Error(`SFP_SUPERSEDE_REJECTED:not_frozen:current_state=${run.cohort_state}`);

    const updated = rows(await tx.execute(sql`
      UPDATE sfp_cohort_runs
      SET cohort_state = 'superseded', superseded_at = NOW(),
          superseded_by_run_id = ${opts.supersededByRunId}::uuid, superseded_by_actor = ${opts.actorId}
      WHERE id = ${opts.cohortRunId}::uuid
      RETURNING *
    `))[0];
    await tx.execute(sql`
      INSERT INTO audit_logs (action, entity_type, entity_key, actor_type, actor_id, details)
      VALUES ('sfp_cohort_run_superseded', 'sfp_cohort_run', ${opts.cohortRunId}, 'user', ${opts.actorId},
              ${JSON.stringify(sanitizeAuditPayload({ supersededByRunId: opts.supersededByRunId }))}::jsonb)
    `);
    return _mapRun(updated);
  });
}

/** True only for a frozen, non-voided, non-superseded cohort run — the sole
 *  admission condition every downstream service must require. */
export function isCohortUsableDownstream(run: { cohortState: string; voidedAt: string | null; supersededAt: string | null }): boolean {
  return run.cohortState === "frozen" && !run.voidedAt && !run.supersededAt;
}

/**
 * Terminal decision-ledger reconciliation for a cohort run: the raw
 * per-disposition breakdown from sfp_cohort_decisions plus the total
 * scanned-canonical-business count at the time of query, so the UI can show
 * "terminal decisions sum to total scanned" as a fact distinct from
 * downstream stage-progress metrics (validation/staging counts live
 * elsewhere and must never be conflated with this reconciliation).
 */
export interface SfpTerminalReconciliation {
  cohortRunId: string;
  byDisposition: Array<{ disposition: string; count: number }>;
  totalDecisions: number;
  totalScannedCanonical: number;
  reconciles: boolean;
}

export async function getCohortRunReconciliation(cohortRunId: string): Promise<SfpTerminalReconciliation> {
  const run = rows(await db.execute(sql`SELECT id, cohort_state FROM sfp_cohort_runs WHERE id=${cohortRunId}::uuid`))[0];
  if (!run) throw new Error("SFP_COHORT_RUN_NOT_FOUND");
  const byDisposition = rows(await db.execute(sql`
    SELECT disposition, COUNT(*)::int AS count FROM sfp_cohort_decisions
    WHERE cohort_run_id = ${cohortRunId}::uuid
    GROUP BY disposition ORDER BY disposition
  `)).map((r: any) => ({ disposition: String(r.disposition), count: Number(r.count) }));
  const totalDecisions = byDisposition.reduce((sum, r) => sum + r.count, 0);
  // VFC-05: compare against the FROZEN funnel snapshot's total_businesses,
  // never a live `COUNT(*) FROM businesses` query. The live table keeps
  // growing after a cohort freezes (new imports, enrichment, etc.), so a
  // live count would silently drift out of reconciliation for every run
  // that isn't the very latest one — reconciliation must describe what was
  // true AT FREEZE TIME, which is exactly what the funnel snapshot records.
  const snapshotRow = rows(await db.execute(sql`
    SELECT total_businesses FROM sfp_funnel_snapshots WHERE cohort_run_id = ${cohortRunId}::uuid LIMIT 1
  `))[0];
  if (!snapshotRow) {
    throw new Error(`SFP_NO_FUNNEL_SNAPSHOT:cohort_run_id=${cohortRunId}:cannot_reconcile_without_a_frozen_snapshot`);
  }
  const totalScannedCanonical = Number(snapshotRow.total_businesses ?? 0);
  return {
    cohortRunId,
    byDisposition,
    totalDecisions,
    totalScannedCanonical,
    reconciles: totalDecisions === totalScannedCanonical,
  };
}

function _mapRun(row: any): SfpCohortRun {
  let requestPayload: any = row.request_payload;
  if (typeof requestPayload === "string") {
    try { requestPayload = JSON.parse(requestPayload); } catch {
      throw new Error("SFP_COHORT_RUN_REQUEST_PAYLOAD_CORRUPT");
    }
  }
  const selectedContactIds = normalizeFrozenContactScope(requestPayload?.selectedContactIds);
  const selectedContactTargets = Array.isArray(requestPayload?.selectedContactTargets)
    ? requestPayload.selectedContactTargets.map((target: any) => ({
        contactId: Number(target.contactId),
        businessId: Number(target.businessId),
        linkDecisionId: String(target.linkDecisionId),
        linkRevision: Number(target.linkRevision),
      }))
    : undefined;
  return {
    id: String(row.id),
    programId: String(row.program_id),
    idempotencyKey: String(row.idempotency_key),
    status: String(row.status),
    cohortState: (row.cohort_state ?? "freezing") as SfpCohortRun["cohortState"],
    cohortSize: Number(row.cohort_size ?? 0),
    cohortHash: row.cohort_hash ? String(row.cohort_hash) : null,
    frozenAt: row.frozen_at ? String(row.frozen_at) : null,
    releaseSha: String(row.release_sha ?? ""),
    actorId: String(row.actor_id),
    createdAt: String(row.created_at),
    requestHash: row.request_hash ? String(row.request_hash) : null,
    configHash: row.config_hash ? String(row.config_hash) : null,
    voidedAt: row.voided_at ? String(row.voided_at) : null,
    voidReason: row.void_reason ? String(row.void_reason) : null,
    supersededAt: row.superseded_at ? String(row.superseded_at) : null,
    supersededByRunId: row.superseded_by_run_id ? String(row.superseded_by_run_id) : null,
    sourceSnapshotHash: row.source_snapshot_hash ? String(row.source_snapshot_hash) : null,
    sourceHighWaterBusinessId: row.source_high_water_business_id != null ? Number(row.source_high_water_business_id) : null,
    sourceBusinessCount: row.source_business_count != null ? Number(row.source_business_count) : null,
    sourceSnapshotCapturedAt: row.source_snapshot_captured_at ? String(row.source_snapshot_captured_at) : null,
    ...(selectedContactIds ? {
      selectedContactScope: {
        selectedContactIds,
        resolvedTargets: selectedContactTargets ?? [],
        previewSnapshotHash: String(requestPayload?.previewSnapshotHash ?? ""),
      },
    } : {}),
  };
}

// ── Free discovery report ─────────────────────────────────────────────────────

export interface SfpFreeEvidenceReport {
  cohortRunId: string;
  cohortSize: number;
  businessesWithCandidates: number;
  businessesWithoutCandidates: number;
  totalCandidates: number;
  perBusiness: Array<{
    businessId: number;
    candidateCount: number;
    bestCandidateMasked: string | null;
    bestCandidateConfidence: number | null;
    disposition: string;
  }>;
  capturedAt: string;
}

export async function getFreeEvidenceReport(cohortRunId: string): Promise<SfpFreeEvidenceReport> {
  const runRow = rows(await db.execute(sql`
    SELECT * FROM sfp_cohort_runs WHERE id = ${cohortRunId}::uuid LIMIT 1
  `))[0];
  if (!runRow) throw new Error("SFP_COHORT_RUN_NOT_FOUND");
  if (runRow.cohort_state !== "frozen" || runRow.voided_at || runRow.superseded_at) {
    throw new Error(`SFP_COHORT_NOT_FROZEN:state=${runRow.cohort_state}`);
  }

  const members = rows(await db.execute(sql`
    SELECT business_id FROM sfp_cohort_members
    WHERE cohort_run_id = ${cohortRunId}::uuid
    ORDER BY roi_score DESC
  `));
  const bizIds = members.map((m: any) => Number(m.business_id));
  if (bizIds.length === 0) {
    return { cohortRunId, cohortSize: 0, businessesWithCandidates: 0, businessesWithoutCandidates: 0,
             totalCandidates: 0, perBusiness: [], capturedAt: new Date().toISOString() };
  }

  const candidateRows = rows(await db.execute(sql`
    SELECT
      fdc.business_id,
      COUNT(*)::int AS candidate_count,
      MAX(fdc.confidence) AS best_confidence,
      (SELECT fdc2.masked_value FROM free_discovery_candidates fdc2
       WHERE fdc2.business_id = fdc.business_id AND fdc2.disposition IN ('staged', 'validation_admitted')
       ORDER BY fdc2.confidence DESC, fdc2.created_at ASC LIMIT 1) AS best_masked,
      (SELECT fdc2.disposition FROM free_discovery_candidates fdc2
       WHERE fdc2.business_id = fdc.business_id
       ORDER BY fdc2.confidence DESC LIMIT 1) AS top_disposition
    FROM free_discovery_candidates fdc
    WHERE fdc.business_id = ANY(ARRAY[${sql.join(bizIds.map((id) => sql`${id}::int`), sql`, `)}])
      AND fdc.disposition IN ('staged', 'validation_admitted')
    GROUP BY fdc.business_id
  `));

  const candMap = new Map<number, any>();
  for (const r of candidateRows) candMap.set(Number(r.business_id), r);

  let withCandidates = 0;
  let totalCandidates = 0;
  const perBusiness = bizIds.map((bizId) => {
    const cand = candMap.get(bizId);
    if (cand) {
      withCandidates++;
      totalCandidates += Number(cand.candidate_count);
      return {
        businessId: bizId,
        candidateCount: Number(cand.candidate_count),
        bestCandidateMasked: cand.best_masked ? String(cand.best_masked) : null,
        bestCandidateConfidence: cand.best_confidence ? Number(cand.best_confidence) : null,
        disposition: String(cand.top_disposition ?? "staged"),
      };
    }
    return { businessId: bizId, candidateCount: 0, bestCandidateMasked: null, bestCandidateConfidence: null, disposition: "no_candidate" };
  });

  return {
    cohortRunId,
    cohortSize: bizIds.length,
    businessesWithCandidates: withCandidates,
    businessesWithoutCandidates: bizIds.length - withCandidates,
    totalCandidates,
    perBusiness,
    capturedAt: new Date().toISOString(),
  };
}

export interface SfpFreeDiscoveryResult {
  stageRunId: string;
  cohortRunId: string;
  selected: number;
  enriched: number;
  failed: number;
  skipped: number;
  replayed: boolean;
  completedAt: string;
}

/**
 * Execute the real free-only crawler for a frozen ROI cohort. This is not a
 * report endpoint: it calls the canonical free lane and durably records the
 * bounded stage run. The free lane's paid-provider kill line remains intact.
 */
export async function runSfpFreeDiscovery(input: {
  cohortRunId: string;
  idempotencyKey: string;
  actorId: string;
  maxBusinesses?: number;
}): Promise<SfpFreeDiscoveryResult> {
  const maxBusinesses = Math.max(1, Math.min(500, Number(input.maxBusinesses ?? 100)));
  const cohort = rows(await db.execute(sql`
    SELECT r.id, r.cohort_hash, r.cohort_state, r.voided_at, r.superseded_at, p.is_active
      FROM sfp_cohort_runs r JOIN sfp_programs p ON p.id = r.program_id
     WHERE r.id = ${input.cohortRunId}::uuid
  `))[0];
  if (!cohort) throw new Error("SFP_COHORT_RUN_NOT_FOUND");
  if (cohort.cohort_state !== "frozen" || cohort.voided_at || cohort.superseded_at) {
    throw new Error(`SFP_COHORT_NOT_FROZEN:state=${cohort.cohort_state}`);
  }
  if (!cohort.is_active) throw new Error("SFP_PROGRAM_INACTIVE");

  const existing = rows(await db.execute(sql`
    SELECT * FROM sfp_stage_runs WHERE stage='free_discovery' AND idempotency_key=${input.idempotencyKey} LIMIT 1
  `))[0];
  if (existing?.state === "completed") {
    return {
      stageRunId: String(existing.id), cohortRunId: input.cohortRunId,
      selected: Number(existing.selected_count), enriched: Number(existing.succeeded_count),
      failed: Number(existing.failed_count), skipped: Number(existing.skipped_count),
      replayed: true, completedAt: String(existing.completed_at),
    };
  }

  const stage = existing ?? rows(await db.execute(sql`
    INSERT INTO sfp_stage_runs
      (cohort_run_id, stage, idempotency_key, actor_id, state, max_items, started_at, last_heartbeat_at)
    VALUES (${input.cohortRunId}::uuid, 'free_discovery', ${input.idempotencyKey}, ${input.actorId},
            'running', ${maxBusinesses}, NOW(), NOW())
    ON CONFLICT (stage, idempotency_key) DO UPDATE
      SET state=CASE WHEN sfp_stage_runs.state IN ('failed','stalled','partial') THEN 'running' ELSE sfp_stage_runs.state END,
          last_heartbeat_at=NOW(), updated_at=NOW()
    RETURNING *
  `))[0];

  const members = rows(await db.execute(sql`
    SELECT m.business_id
      FROM sfp_cohort_members m
      JOIN businesses b ON b.id=m.business_id
     WHERE m.cohort_run_id=${input.cohortRunId}::uuid
       AND b.record_class='canonical'
       AND b.website_domain IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM sfp_stage_items i
          WHERE i.stage_run_id=${String(stage.id)}::uuid AND i.business_id=m.business_id
            AND i.provider='first_party_web' AND i.state IN ('completed','no_result','skipped')
       )
     ORDER BY m.roi_score DESC, m.business_id ASC
     LIMIT ${maxBusinesses}
  `));
  const businessIds = members.map((m: any) => Number(m.business_id));
  await db.execute(sql`
    UPDATE sfp_stage_runs SET selected_count=${businessIds.length}, last_heartbeat_at=NOW(), updated_at=NOW()
     WHERE id=${String(stage.id)}::uuid
  `);
  for (const businessId of businessIds) {
    await db.execute(sql`
      INSERT INTO sfp_stage_items (stage_run_id,business_id,provider,state)
      VALUES (${String(stage.id)}::uuid,${businessId},'first_party_web','pending')
      ON CONFLICT (stage_run_id,business_id,provider) DO NOTHING
    `);
  }

  const { runFreeEnrichmentLane } = await import("../free-enrichment-lane");
  let laneResults: Awaited<ReturnType<typeof runFreeEnrichmentLane>> = [];
  try {
    laneResults = await runFreeEnrichmentLane(businessIds);
  } catch (error: any) {
    await db.execute(sql`
      UPDATE sfp_stage_runs SET state='failed', terminal_reason=${String(error?.message ?? error).slice(0, 200)},
             completed_at=NOW(),updated_at=NOW() WHERE id=${String(stage.id)}::uuid
    `);
    throw error;
  }
  const enriched = laneResults.filter((r) => r.outcome === "enriched").length;
  const failed = laneResults.filter((r) => r.outcome === "failed").length;
  const skipped = laneResults.filter((r) => r.outcome === "skipped").length;
  for (const result of laneResults) {
    await db.execute(sql`
      UPDATE sfp_stage_items SET state=${result.outcome === "enriched" ? "completed" : result.outcome === "failed" ? "failed" : "skipped"},
             outcome_code=${result.error ?? result.outcome},completed_at=NOW(),updated_at=NOW()
       WHERE stage_run_id=${String(stage.id)}::uuid AND business_id=${result.businessId} AND provider='first_party_web'
    `);
  }
  const completedAt = new Date().toISOString();
  await db.execute(sql`
    UPDATE sfp_stage_runs SET state=${failed > 0 ? "partial" : "completed"},processed_count=${laneResults.length},
           succeeded_count=${enriched},failed_count=${failed},skipped_count=${skipped},
           last_heartbeat_at=NOW(),completed_at=${completedAt}::timestamptz,updated_at=NOW()
     WHERE id=${String(stage.id)}::uuid
  `);
  return { stageRunId: String(stage.id), cohortRunId: input.cohortRunId, selected: businessIds.length,
           enriched, failed, skipped, replayed: false, completedAt };
}

// ── Validated outreach prospects ───────────────────────────────────────────────

export interface ValidatedProspect {
  eligibilityId: string;
  businessId: number;
  businessName: string | null;
  normalizedVertical: string | null;
  county: string | null;
  roiScore: number;
  maskedEmail: string | null;
  namedContact: boolean;
  roleInbox: boolean;
  discoverySource: string | null;
  evidenceConfidence: number | null;
  validationStatus: OutreachEligibilityStatus;
  validationAt: string | null;
  validationAgeDays: number | null;
  zbOutcome: string | null;
  suppressionStatus: string;
  outreachPolicyStatus: string;
  exclusionReason: string | null;
  campaignStagedAt: string | null;
  policyVersion: number;
  sourceKind: string | null;
  consentTier: string | null;
  policyDocumentHash: string | null;
  reasonCodes: string[];
}

export async function getValidatedProspects(opts: {
  cohortRunId: string;
  filters?: {
    county?: string;
    vertical?: string;
    namedContact?: boolean;
    roleInbox?: boolean;
    status?: OutreachEligibilityStatus;
    source?: string;
    outreachEligible?: boolean;
    reviewRequired?: boolean;
  };
  limit?: number;
  offset?: number;
}): Promise<{ prospects: ValidatedProspect[]; total: number; byCohort: Record<string, number> }> {
  const { cohortRunId, filters = {}, limit = 50, offset = 0 } = opts;

  let whereClause = sql`soe.cohort_run_id = ${cohortRunId}::uuid`;
  if (filters.county) whereClause = sql`${whereClause} AND scm.county_fips = ${filters.county}`;
  if (filters.vertical) whereClause = sql`${whereClause} AND b.vertical = ${filters.vertical}`;
  if (filters.source) whereClause = sql`${whereClause} AND soe.discovery_source = ${filters.source}`;
  if (filters.namedContact !== undefined) whereClause = sql`${whereClause} AND soe.named_contact = ${filters.namedContact}`;
  if (filters.roleInbox !== undefined) whereClause = sql`${whereClause} AND soe.role_inbox = ${filters.roleInbox}`;
  if (filters.status) whereClause = sql`${whereClause} AND soe.status = ${filters.status}`;
  if (filters.outreachEligible) whereClause = sql`${whereClause} AND soe.status = 'validated_outreach_eligible'`;
  if (filters.reviewRequired) whereClause = sql`${whereClause} AND soe.status IN ('validated_review_required','catch_all_review')`;

  // One filtered CTE feeds page rows, the exact total, and the grouped
  // counts, so every consumer reconciles against the same filtered relation
  // instead of the page query and the aggregate queries silently drifting
  // apart (e.g. filters applied to rows but not to the total, or the total
  // querying a table alias it never joined).
  const filteredCte = sql`
    WITH filtered AS (
      SELECT
        soe.*,
        b.canonical_name AS business_name,
        b.vertical AS business_vertical,
        scm.roi_score,
        scm.county_fips,
        scm.geography_class,
        EXTRACT(EPOCH FROM (NOW() - soe.validation_at)) / 86400.0 AS validation_age_days
      FROM sfp_outreach_eligibility soe
      JOIN sfp_cohort_members scm ON scm.cohort_run_id = soe.cohort_run_id
        AND scm.business_id = soe.business_id
      JOIN businesses b ON b.id = soe.business_id
      WHERE ${whereClause}
    )
  `;

  const prospectRows = rows(await db.execute(sql`
    ${filteredCte}
    SELECT * FROM filtered
    ORDER BY roi_score DESC, created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `));

  const totalRow = rows(await db.execute(sql`
    ${filteredCte}
    SELECT COUNT(*)::int AS cnt FROM filtered
  `))[0];

  const statusRows = rows(await db.execute(sql`
    ${filteredCte}
    SELECT status, COUNT(*)::int AS cnt FROM filtered GROUP BY status
  `));
  const byCohort: Record<string, number> = {};
  for (const r of statusRows) byCohort[String(r.status)] = Number(r.cnt);

  const prospects: ValidatedProspect[] = prospectRows.map((r: any) => ({
    eligibilityId: String(r.id),
    businessId: Number(r.business_id),
    businessName: r.business_name ? String(r.business_name) : null,
    normalizedVertical: r.business_vertical ? String(r.business_vertical) : null,
    county: r.county_fips ? String(r.county_fips) : null,
    roiScore: Number(r.roi_score ?? 0),
    maskedEmail: r.masked_email ? String(r.masked_email) : null,
    namedContact: Boolean(r.named_contact),
    roleInbox: Boolean(r.role_inbox),
    discoverySource: r.discovery_source ? String(r.discovery_source) : null,
    evidenceConfidence: r.evidence_confidence ? Number(r.evidence_confidence) : null,
    validationStatus: r.status as OutreachEligibilityStatus,
    validationAt: r.validation_at ? String(r.validation_at) : null,
    validationAgeDays: r.validation_age_days ? Number(r.validation_age_days) : null,
    zbOutcome: r.zb_outcome ? String(r.zb_outcome) : null,
    suppressionStatus: String(r.suppression_status ?? "unchecked"),
    outreachPolicyStatus: r.status === "validated_outreach_eligible" ? "eligible" : "ineligible",
    exclusionReason: r.decision_reason ? String(r.decision_reason) : null,
    campaignStagedAt: r.campaign_staged_at ? String(r.campaign_staged_at) : null,
    policyVersion: Number(r.policy_version ?? 1),
    sourceKind: r.source_kind ? String(r.source_kind) : null,
    consentTier: r.consent_tier ? String(r.consent_tier) : null,
    policyDocumentHash: r.policy_document_hash ? String(r.policy_document_hash) : null,
    reasonCodes: Array.isArray(r.reason_codes) ? r.reason_codes.map(String) : [],
  }));

  return { prospects, total: Number(totalRow?.cnt ?? 0), byCohort };
}

// ── Campaign staging ───────────────────────────────────────────────────────────

export interface CampaignStagingPreview {
  cohortRunId: string;
  eligibleCount: number;
  alreadyStagedCount: number;
  willStageCount: number;
  ineligibleCount: number;
  ineligibleReasons: Record<string, number>;
  capturedAt: string;
}

export interface CampaignStagingResult {
  cohortRunId: string;
  idempotencyKey: string;
  created: number;
  skipped: number;
  rejected: number;
  reasons: Record<string, number>;
  /** Always true — this action never sends email/SMS/GHL outreach */
  zeroOutreachConfirmed: true;
  completedAt: string;
}

/**
 * Preview campaign staging for eligible prospects.
 * Read-only; no mutations.
 */
export async function previewCampaignStaging(cohortRunId: string): Promise<CampaignStagingPreview> {
  const statusRows = rows(await db.execute(sql`
    SELECT status, COUNT(*)::int AS cnt
    FROM sfp_outreach_eligibility
    WHERE cohort_run_id = ${cohortRunId}::uuid
    GROUP BY status
  `));

  const byCohort: Record<string, number> = {};
  for (const r of statusRows) byCohort[String(r.status)] = Number(r.cnt);

  const eligibleCount = byCohort["validated_outreach_eligible"] ?? 0;
  const alreadyStagedCount = rows(await db.execute(sql`
    SELECT COUNT(*)::int AS cnt FROM sfp_outreach_eligibility
    WHERE cohort_run_id = ${cohortRunId}::uuid
      AND campaign_staged_at IS NOT NULL
  `))[0]?.cnt ?? 0;

  const willStageCount = Math.max(0, eligibleCount - Number(alreadyStagedCount));
  const ineligibleCount = Object.values(byCohort).reduce((s, v) => s + v, 0) - eligibleCount;

  const reasons: Record<string, number> = {};
  for (const [status, cnt] of Object.entries(byCohort)) {
    if (status !== "validated_outreach_eligible") reasons[status] = cnt;
  }

  return {
    cohortRunId,
    eligibleCount,
    alreadyStagedCount: Number(alreadyStagedCount),
    willStageCount,
    ineligibleCount,
    ineligibleReasons: reasons,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Stage selected eligible prospects for campaign.
 *
 * Per-prospect gates re-verified at execution time:
 *   - validation_status = validated_outreach_eligible
 *   - validation freshness (< 180 days)
 *   - suppression re-check
 *   - DBPR re-check
 *   - existing customer re-check
 *   - cold-outreach policy
 *
 * No email is sent. No sequence is enrolled. No GHL write occurs.
 * Outbound remains paused unless separately authorized.
 */
export async function stageForCampaign(opts: {
  cohortRunId: string;
  idempotencyKey: string;
  actorId: string;
  businessIds?: number[];  // if omitted, stage all eligible
}): Promise<CampaignStagingResult> {
  const { cohortRunId, idempotencyKey, actorId } = opts;
  const activePolicy = await getActiveSfpOutreachPolicy();

  let whereExtra = sql``;
  if (opts.businessIds && opts.businessIds.length > 0) {
    whereExtra = sql`AND business_id = ANY(ARRAY[${sql.join(opts.businessIds.map((id) => sql`${id}::int`), sql`, `)}])`;
  }

  // Task #2000 fence correction: enumerate EVERY eligible eligibility row
  // first, via a LEFT JOIN to the (free-only) candidate table. An earlier
  // revision started from an INNER JOIN on free_discovery_candidates, which
  // silently dropped every paid-source-eligible row (candidate_id IS NULL)
  // before this loop ever saw it — reporting a false "nothing to stage"
  // instead of the true, Task-2001-blocked count. This staging path itself
  // only completes free-source rows; paid-source rows are explicitly
  // rejected below with an exact, visible count and reason code, never
  // silently staged and never silently omitted.
  const eligibleRows = rows(await db.execute(sql`
    SELECT soe.id, soe.cohort_run_id, soe.business_id, soe.candidate_id, soe.paid_candidate_evidence_id, soe.source_kind,
           soe.policy_version,
           soe.status, soe.zb_outcome, soe.validation_at, soe.validation_expires_at, soe.masked_email, soe.role_inbox,
           soe.campaign_staged_at, soe.decision_reason, fdc.normalized_value_hash,
           b.canonical_name,b.website_domain,b.main_phone,b.vertical,b.city,b.state
    FROM sfp_outreach_eligibility soe
    LEFT JOIN free_discovery_candidates fdc ON fdc.id=soe.candidate_id
    JOIN businesses b ON b.id=soe.business_id
    WHERE soe.cohort_run_id = ${cohortRunId}::uuid
      AND soe.status = 'validated_outreach_eligible'
      ${whereExtra}
  `));

  let created = 0;
  let skipped = 0;
  let rejected = 0;
  const reasons: Record<string, number> = {};

  for (const row of eligibleRows) {
    // Already staged (idempotent)
    if (row.campaign_staged_at) {
      skipped++;
      reasons["already_staged"] = (reasons["already_staged"] ?? 0) + 1;
      continue;
    }

    // Task #2000/#2001 boundary: this staging path only knows how to complete
    // free-source candidates. A paid-source (Outscraper/Apollo/Serper)
    // eligible row is real, valid, staging-review-eligible evidence — it is
    // explicitly reported as blocked pending Task #2001's paid-source
    // staging support, never silently dropped, never silently staged.
    if (row.source_kind === "paid" || (!row.candidate_id && row.paid_candidate_evidence_id)) {
      rejected++;
      reasons["paid_source_task2001_blocked"] = (reasons["paid_source_task2001_blocked"] ?? 0) + 1;
      continue;
    }

    // Freshness check driven by the active outreach policy's TTL
    // (validation_expires_at was stamped from policy.validationTtlDays at
    // validation time), never a hardcoded window independent of the
    // pinned policy document.
    // Legacy rows written before policy_document tracking existed have a
    // NULL validation_expires_at. Fail closed for them by deriving an
    // expiry from validation_at + the CURRENT active policy's TTL, rather
    // than letting a NULL bypass the freshness check entirely.
    const effectiveExpiresAt = row.validation_expires_at
      ? new Date(String(row.validation_expires_at))
      : row.validation_at
        ? new Date(new Date(String(row.validation_at)).getTime() + activePolicy.validationTtlDays * 86_400_000)
        : null;
    if (!effectiveExpiresAt || effectiveExpiresAt.getTime() < Date.now()) {
      rejected++;
      reasons["validation_stale"] = (reasons["validation_stale"] ?? 0) + 1;
      await db.execute(sql`
        UPDATE sfp_outreach_eligibility
        SET status = 'validation_pending', decision_reason = 'validation_expired_per_policy_ttl',
            updated_at = NOW()
        WHERE id = ${String(row.id)}::uuid
      `);
      continue;
    }

    // Re-check DBPR
    const dbprCheck = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM contacts con
      JOIN contact_source_events cse ON cse.contact_id = con.id
      WHERE con.business_id = ${Number(row.business_id)}
        AND cse.source_type = 'dbpr'
    `))[0];
    if (Number(dbprCheck?.cnt) > 0) {
      rejected++;
      reasons["dbpr_excluded"] = (reasons["dbpr_excluded"] ?? 0) + 1;
      await db.execute(sql`
        UPDATE sfp_outreach_eligibility
        SET status = 'validated_policy_ineligible', decision_reason = 'dbpr_excluded_at_staging',
            updated_at = NOW()
        WHERE id = ${String(row.id)}::uuid
      `);
      continue;
    }

    // Re-check existing customer
    const custCheck = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM sdr_merchants
      WHERE business_id = ${Number(row.business_id)} AND existing_customer_flag = true
    `))[0];
    if (Number(custCheck?.cnt) > 0) {
      rejected++;
      reasons["existing_customer"] = (reasons["existing_customer"] ?? 0) + 1;
      await db.execute(sql`
        UPDATE sfp_outreach_eligibility
        SET status = 'validated_existing_relationship', decision_reason = 'existing_customer_at_staging',
            updated_at = NOW()
        WHERE id = ${String(row.id)}::uuid
      `);
      continue;
    }

    // Re-check the canonical contact suppression/bounce surface at the final
    // staging boundary. A provider-valid result is deliverability evidence;
    // it never overrides an opt-out, complaint, hard bounce, or DNC marker.
    const suppressionCheck = rows(await db.execute(sql`
      SELECT EXISTS(
        SELECT 1
        FROM contacts c
        WHERE c.email_token_hash = ${String(row.normalized_value_hash)}
          AND (
            COALESCE(c.opted_out_email, FALSE) = TRUE
            OR c.opt_out_status = 'opted_out'
            OR c.unsubscribe_status = 'unsubscribed'
            OR c.complaint_status = 'reported'
            OR COALESCE(c.do_not_auto_contact, FALSE) = TRUE
            OR c.suppression_reason IS NOT NULL
            OR c.bounce_status = 'hard'
            OR c.email_status IN ('bounced', 'invalid')
          )
      ) AS suppressed
    `))[0];
    if (suppressionCheck?.suppressed === true) {
      rejected++;
      reasons["suppressed_at_staging"] = (reasons["suppressed_at_staging"] ?? 0) + 1;
      await db.execute(sql`
        UPDATE sfp_outreach_eligibility
        SET status = 'validated_suppressed', decision_reason = 'suppressed_at_staging',
            suppression_status = 'suppressed', updated_at = NOW()
        WHERE id = ${String(row.id)}::uuid
      `);
      continue;
    }

    if (!row.candidate_id) {
      rejected++;
      reasons["candidate_missing"] = (reasons["candidate_missing"] ?? 0) + 1;
      continue;
    }
    const plaintextEmail = await decryptCandidateEmail(String(row.candidate_id));
    if (!plaintextEmail) {
      rejected++;
      reasons["candidate_decryption_failed"] = (reasons["candidate_decryption_failed"] ?? 0) + 1;
      continue;
    }
    const contactEmailTokenHash = createHash("sha256")
      .update(plaintextEmail.trim().toLowerCase())
      .digest("hex");
    const plaintextSuppression = rows(await db.execute(sql`
      SELECT EXISTS(
        SELECT 1 FROM contacts c
         WHERE c.email_token_hash = ${contactEmailTokenHash}
           AND (
             COALESCE(c.opted_out_email, FALSE) = TRUE
             OR c.opt_out_status = 'opted_out'
             OR c.unsubscribe_status = 'unsubscribed'
             OR c.complaint_status = 'reported'
             OR COALESCE(c.do_not_auto_contact, FALSE) = TRUE
             OR c.suppression_reason IS NOT NULL
             OR c.bounce_status = 'hard'
             OR c.email_status IN ('bounced', 'invalid')
           )
      ) AS suppressed
    `))[0];
    if (plaintextSuppression?.suppressed === true) {
      rejected++;
      reasons["suppressed_at_staging"] = (reasons["suppressed_at_staging"] ?? 0) + 1;
      await db.execute(sql`
        UPDATE sfp_outreach_eligibility
           SET status='validated_suppressed',decision_reason='suppressed_at_staging',
               suppression_status='suppressed',updated_at=NOW()
         WHERE id=${String(row.id)}::uuid
      `);
      continue;
    }
    // Create a real, durable staging intent. This is intentionally still a
    // no-send boundary: campaign/GHL workers do not consume this table.
    //
    // Conflict target: migration 0290 (Task #2001) dropped the old
    // (cohort_run_id,business_id,candidate_id) unique index — it could never
    // hold for paid-source rows, where candidate_id is NULL — and replaced
    // it with sfp_campaign_intent_eligibility_live_uidx, a partial unique
    // index on (eligibility_id) WHERE state NOT IN
    // ('rejected','cancelled','superseded'). ON CONFLICT against a partial
    // index must repeat its exact predicate here, or Postgres cannot infer
    // the arbiter index and this insert would raise
    // "there is no unique or exclusion constraint matching the ON CONFLICT
    // specification" for every row.
    let staged: { staged: boolean; reason?: string };
    try {
      staged = await db.transaction(async (tx) => {
      await lockSfpEligibilityProjectionWriteGate(tx);
      await lockCurrentSfpOutreachPolicy(tx, activePolicy);
      await lockSfpBusinessSafetySentinel(tx, Number(row.business_id));
      await lockSfpContactAddress(tx, plaintextEmail);
      await lockSfpEligibilityProjectionKey(
        tx, String(row.cohort_run_id), Number(row.business_id), Number(activePolicy.version),
      );
      const current = rows(await tx.execute(sql`
        SELECT e.id,e.cohort_run_id,e.business_id,e.candidate_id,e.policy_version,
               e.status,e.campaign_staged_at,e.normalized_value_hash,e.normalized_value_hash_version,
               e.validation_at,e.validation_expires_at,b.canonical_name,b.website_domain,
               b.main_phone,b.vertical,b.city,b.state
          FROM sfp_outreach_eligibility e
          JOIN businesses b ON b.id=e.business_id
         WHERE e.id=${String(row.id)}::uuid
           AND e.cohort_run_id=${cohortRunId}::uuid
           AND e.business_id=${Number(row.business_id)}
         FOR UPDATE OF e
         FOR SHARE OF b
      `))[0];
      if (!current || current.status !== "validated_outreach_eligible" ||
          String(current.candidate_id) !== String(row.candidate_id)) {
        return { staged: false, reason: "eligibility_source_changed_at_commit" };
      }
      if (current.campaign_staged_at) return { staged: false, reason: "already_staged" };
      if (Number(current.policy_version) !== activePolicy.version) {
        await tx.execute(sql`
          UPDATE sfp_outreach_eligibility
             SET status='validated_policy_ineligible',
                 decision_reason='outreach_policy_changed_at_staging_commit',updated_at=NOW()
           WHERE id=${String(current.id)}::uuid
        `);
        return { staged: false, reason: "outreach_policy_changed_at_staging_commit" };
      }

      const currentAddressHash = normalizedSfpEmailHash(plaintextEmail, current.normalized_value_hash_version);
      const currentSource = rows(await tx.execute(sql`
        SELECT id,business_id,field,disposition,normalized_value_hash
          FROM free_discovery_candidates
         WHERE id=${String(current.candidate_id)}::uuid
           AND business_id=${Number(current.business_id)}
           AND field='email' AND subject_type='business'
           AND disposition='staged' AND contact_id IS NULL
         FOR SHARE
      `))[0];
      if (!currentAddressHash || currentAddressHash !== String(current.normalized_value_hash ?? "") ||
          !currentSource || String(currentSource.normalized_value_hash ?? "") !== String(current.normalized_value_hash ?? "")) {
        await tx.execute(sql`
          UPDATE sfp_outreach_eligibility
             SET status='validated_review_required',
                 decision_reason='candidate_or_address_pin_stale_at_staging_commit',
                 updated_at=NOW()
           WHERE id=${String(current.id)}::uuid
        `);
        return { staged: false, reason: "candidate_or_address_pin_stale_at_staging_commit" };
      }

      const consentTier = await lookupConsentTierByEmailHash(contactEmailTokenHash, tx);
      const suppressed = await isCanonicallySuppressed(
        [contactEmailTokenHash, String(current.normalized_value_hash)], tx, [plaintextEmail],
      );
      const gate = await evaluateSfpMutableSafetyGates({
        businessId: Number(current.business_id),
        consentTier,
        policy: activePolicy,
        emailAddress: plaintextEmail,
      }, tx);
      if (suppressed || !gate.eligible) {
        let status = "validated_suppressed";
        if (!suppressed && !gate.eligible) status = gate.status;
        const reason = suppressed ? "canonical_suppression_match_at_staging_commit" : gate.reasonCode;
        await tx.execute(sql`
          UPDATE sfp_outreach_eligibility
             SET status=${status},decision_reason=${reason},
                 suppression_status=${suppressed ? "suppressed" : "not_suppressed"},updated_at=NOW()
           WHERE id=${String(current.id)}::uuid
        `);
        return { staged: false, reason };
      }
      if (!(await isCurrentSfpValidationReceiptFresh(tx, {
        eligibilityId: String(current.id),
        businessId: Number(current.business_id),
        emailTokenHash: contactEmailTokenHash,
      }))) {
        await tx.execute(sql`
          UPDATE sfp_outreach_eligibility
             SET status='validation_pending',
                 decision_reason='provider_observation_expired_before_staging_commit',
                 updated_at=NOW()
           WHERE id=${String(current.id)}::uuid
        `);
        return { staged: false, reason: "provider_observation_expired_before_staging_commit" };
      }

      const intent = rows(await tx.execute(sql`
        INSERT INTO sfp_campaign_staging_intents
          (cohort_run_id,eligibility_id,business_id,candidate_id,source_kind,idempotency_key,actor_id,
           state,policy_version,validation_snapshot,lineage)
        VALUES (${cohortRunId}::uuid,${String(current.id)}::uuid,${Number(current.business_id)},
                ${String(current.candidate_id)}::uuid,'free',${idempotencyKey},${actorId},'staged',${activePolicy.version},
                ${JSON.stringify({ zbOutcome: row.zb_outcome, validationAt: current.validation_at, status: current.status })}::jsonb,
                ${JSON.stringify({ source: "sfp", cohortRunId, eligibilityId: String(current.id) })}::jsonb)
        ON CONFLICT (eligibility_id) WHERE state NOT IN ('rejected','cancelled','superseded')
        DO UPDATE SET updated_at=NOW()
        RETURNING id
      `))[0];
      const masterLead = rows(await tx.execute(sql`
        INSERT INTO master_leads
          (status,company,normalized_company,domain,email,email_type,phone,vertical,
           outreach_readiness,readiness_reason,source,source_path,city,state,website,email_valid,
           pipeline_origin,canonical_business_id,email_token_hash,masked_email,created_at,updated_at)
        VALUES ('staged',${current.canonical_name},LOWER(TRIM(${current.canonical_name})),${current.website_domain},${plaintextEmail},
                ${row.role_inbox ? "role" : "business"},${current.main_phone},${current.vertical},
                'not_ready','awaiting_explicit_campaign_authorization','sfp_validated',
                ${`sfp:${cohortRunId}:${String(current.candidate_id)}`},${current.city},${current.state},${current.website_domain},TRUE,
                'sfp_pipeline',${Number(current.business_id)},${contactEmailTokenHash},${row.masked_email},NOW(),NOW())
        ON CONFLICT (canonical_business_id,email_token_hash)
          WHERE pipeline_origin='sfp_pipeline' AND canonical_business_id IS NOT NULL AND email_token_hash IS NOT NULL
        DO UPDATE SET status='staged',email_valid=TRUE,masked_email=EXCLUDED.masked_email,updated_at=NOW()
        RETURNING id
      `))[0];
      await tx.execute(sql`
        UPDATE sfp_outreach_eligibility
           SET campaign_staged_at=NOW(),campaign_staged_by=${actorId},
               staging_intent_id=${String(intent.id)}::uuid,updated_at=NOW()
         WHERE id=${String(current.id)}::uuid
      `);
      await tx.execute(sql`
        UPDATE sfp_campaign_staging_intents
           SET master_lead_id=${String(masterLead.id)}::uuid,updated_at=NOW()
         WHERE id=${String(intent.id)}::uuid
      `);
      if (!(await isCurrentSfpValidationReceiptFresh(tx, {
        eligibilityId: String(current.id),
        businessId: Number(current.business_id),
        emailTokenHash: contactEmailTokenHash,
      }))) {
        // A rejected return would commit the master-lead upsert. Abort every
        // projection in this transaction instead, including conflict updates.
        throw new Error("SFP_LEGACY_VALIDATION_EXPIRED_AT_STAGING_COMMIT");
      }
      return { staged: true };
      });
    } catch (error: any) {
      if (error?.message !== "SFP_LEGACY_VALIDATION_EXPIRED_AT_STAGING_COMMIT") throw error;
      rejected++;
      reasons.provider_observation_expired_at_staging_commit =
        (reasons.provider_observation_expired_at_staging_commit ?? 0) + 1;
      continue;
    }
    if (!staged.staged) {
      if (staged.reason === "already_staged") {
        skipped++;
        reasons.already_staged = (reasons.already_staged ?? 0) + 1;
      } else {
        rejected++;
        reasons[staged.reason ?? "staging_commit_rejected"] =
          (reasons[staged.reason ?? "staging_commit_rejected"] ?? 0) + 1;
      }
      continue;
    }
    created++;
  }

  return {
    cohortRunId,
    idempotencyKey,
    created,
    skipped,
    rejected,
    reasons,
    zeroOutreachConfirmed: true,
    completedAt: new Date().toISOString(),
  };
}

// ── Cohort run list ────────────────────────────────────────────────────────────

export async function listCohortRuns(opts: {
  programId?: string;
  limit?: number;
} = {}): Promise<SfpCohortRun[]> {
  // Round-2 correction: GET-shaped read must never mutate. ensureProgram()
  // creates the program row on first call — a plain "list runs" request
  // (including one that runs before the program has ever been configured)
  // must not have that side effect. Read-only lookup only; when no program
  // exists yet there simply are no runs to return.
  const program = opts.programId
    ? { id: opts.programId }
    : await getProgramReadOnly();
  if (!program) return [];
  const limit = Math.max(1, Math.min(100, Math.trunc(opts.limit ?? 20)));
  const rows2 = rows(await db.execute(sql`
    SELECT * FROM sfp_cohort_runs
    WHERE program_id = ${program.id}::uuid
    ORDER BY created_at DESC
    LIMIT ${limit}
  `));
  return rows2.map(_mapRun);
}

export async function getCohortRun(cohortRunId: string): Promise<SfpCohortRun | null> {
  const row = rows(await db.execute(sql`
    SELECT * FROM sfp_cohort_runs WHERE id = ${cohortRunId}::uuid LIMIT 1
  `))[0];
  return row ? _mapRun(row) : null;
}

// ── Decryption helper for validation (authorized boundary) ─────────────────────

/**
 * Decrypt a candidate's real email address for ZeroBounce validation.
 * Uses the candidate-evidence envelope boundary — never exposes plaintext
 * in logs, API responses, or telemetry.
 */
export async function decryptCandidateEmail(candidateId: string): Promise<string | null> {
  const candRow = rows(await db.execute(sql`
    SELECT
      id, business_id, field, envelope_ciphertext, envelope_nonce,
      envelope_tag, envelope_key_version, masked_value
    FROM free_discovery_candidates
    WHERE id = ${candidateId}::uuid LIMIT 1
  `))[0];

  if (!candRow) return null;
  if (!candRow.envelope_ciphertext || !candRow.envelope_nonce || !candRow.envelope_tag) {
    // No encrypted envelope — cannot validate
    return null;
  }

  try {
    const decrypted = unsealCandidateEvidence("email", {
      ciphertext: String(candRow.envelope_ciphertext),
      nonce: String(candRow.envelope_nonce),
      tag: String(candRow.envelope_tag),
      keyVersion: Number(candRow.envelope_key_version ?? 1),
    });
    return decrypted;
  } catch (err: any) {
    console.warn(`[SFP] Candidate decryption failed for ${candidateId}: ${err?.message}`);
    return null;
  }
}
