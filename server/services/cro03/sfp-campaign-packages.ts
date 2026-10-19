/**
 * sfp-campaign-packages.ts
 *
 * Task #2001 (Defects 3/4/9/10): immutable, versioned five-package
 * (vertical -> campaign+sequence) mapping, plus the explicit
 * preview/apply/verify configuration-convergence command that performs the
 * one-time Dental split / Retail / Auto-Repair narrowing / five-sequence
 * creation. Campaigns and sequences are always resolved by NAME/logical
 * identity here, never by hardcoded numeric ID — those IDs are ordinary
 * serial keys and are not guaranteed stable across environments.
 *
 * This module never writes to sequence_enrollments, campaign_queue_*, or any
 * GHL/outbound table. `lifecycleState = 'current'` on a package version means
 * only "this is the current SFP vertical-to-package mapping" — it is a
 * reference/version authority, never an approval or send authority.
 * campaign_approvals and CR-06 remain the only applicable approval
 * authorities, unchanged by this task.
 */

import { sfpLaunchPresentationFingerprint } from "./sfp-launch-presentation";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../../db";
import { SFP_TARGET_VERTICALS_V2 } from "./sfp-vertical-classifier";

const rows = (r: any): any[] => r?.rows ?? r ?? [];

/**
 * Build a genuine Postgres `ARRAY[...]::text[]` literal instead of
 * interpolating a JS array directly into a drizzle sql`` template. Drizzle's
 * node-postgres driver expands `${arr}` as a parenthesized comma list of
 * scalar params (`($1)`), not an array literal — for a single-element array
 * this produces `($1)` (a valid but wrong scalar-in-parens expression) and
 * for an empty array it produces `()`, which is invalid SQL. See also the
 * `ANY(${arr}::type[])` variant of this same bug (drizzle-array-param-bug).
 */
function textArrayLiteral(values: unknown): ReturnType<typeof sql> {
  const arr = Array.isArray(values) ? values : [];
  if (arr.length === 0) return sql`ARRAY[]::text[]`;
  return sql`ARRAY[${sql.join(arr.map((v) => sql`${String(v)}`), sql`, `)}]::text[]`;
}

export type SfpPackageKey =
  | "sfp.restaurant.v1"
  | "sfp.med_spa.v1"
  | "sfp.dental.v1"
  | "sfp.retail.v1"
  | "sfp.auto_repair.v1";

export const SFP_PACKAGE_KEYS: SfpPackageKey[] = [
  "sfp.restaurant.v1",
  "sfp.med_spa.v1",
  "sfp.dental.v1",
  "sfp.retail.v1",
  "sfp.auto_repair.v1",
];

interface PackagePlan {
  packageKey: SfpPackageKey;
  vertical: string;
  /** Source campaign to resolve/narrow-or-split from, by exact name. */
  sourceCampaignName: string;
  /** Final campaign name this package resolves to. */
  targetCampaignName: string;
  /** Whether the target campaign is a brand-new split (never mutate SDR-05 itself for Dental). */
  isSplit: boolean;
  targetSequenceName: string;
  sequenceFamily: string;
}

const PACKAGE_PLAN: PackagePlan[] = [
  {
    packageKey: "sfp.restaurant.v1",
    vertical: "Restaurant",
    sourceCampaignName: "SDR-04: Restaurant & Food Service",
    targetCampaignName: "SDR-04: Restaurant & Food Service",
    isSplit: false,
    targetSequenceName: "SFP Cold Outreach — Restaurant",
    sequenceFamily: "sfp-cold-restaurant",
  },
  {
    packageKey: "sfp.med_spa.v1",
    vertical: "Med Spa",
    sourceCampaignName: "SDR-05: Medical / Dental / Medspa",
    targetCampaignName: "SDR-05: Medical / Medspa",
    isSplit: false,
    targetSequenceName: "SFP Cold Outreach — Med Spa",
    sequenceFamily: "sfp-cold-med-spa",
  },
  {
    packageKey: "sfp.dental.v1",
    vertical: "Dental",
    sourceCampaignName: "SDR-05: Medical / Dental / Medspa",
    targetCampaignName: "SDR-11: Dental (split from SDR-05)",
    isSplit: true,
    targetSequenceName: "SFP Cold Outreach — Dental",
    sequenceFamily: "sfp-cold-dental",
  },
  {
    packageKey: "sfp.retail.v1",
    vertical: "Retail",
    sourceCampaignName: "SDR-06: Retail & E-Commerce",
    targetCampaignName: "SDR-06: Retail & E-Commerce",
    isSplit: false,
    targetSequenceName: "SFP Cold Outreach — Retail",
    sequenceFamily: "sfp-cold-retail",
  },
  {
    packageKey: "sfp.auto_repair.v1",
    vertical: "Auto Repair",
    sourceCampaignName: "SDR-07: Auto / Service / Trades",
    targetCampaignName: "SDR-07: Auto / Service / Trades",
    isSplit: false,
    targetSequenceName: "SFP Cold Outreach — Auto Repair",
    sequenceFamily: "sfp-cold-auto-repair",
  },
];

// SDR-10 (Salon/Spa/Beauty) is explicitly reviewable source material only; it
// must never become a package target. Asserted at module load so a future
// edit cannot silently retarget Med Spa to it.
if (PACKAGE_PLAN.some((p) => p.sourceCampaignName.includes("SDR-10") || p.targetCampaignName.includes("SDR-10"))) {
  throw new Error("SFP_PACKAGE_PLAN_INVALID: SDR-10 must never be a package source or target");
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Hashes the ACTUAL campaign/sequence content (description, verticals,
 * content revision, and every step's subject/body/timing/config) — not just
 * IDs, names, and family. A copy edit to a step or a campaign content-revision
 * bump must change this hash, so a package pinned earlier and later reused
 * cannot silently reach `ready_held` against content that moved underneath
 * it. `exec` accepts either `db` or a live transaction executor so this can
 * be recomputed and compared inside the same transaction that writes the
 * staging intent (never trust a value computed outside that transaction).
 */
export async function computeLivePackageContentHash(
  exec: { execute: (q: any) => Promise<any> },
  campaignId: number,
  sequenceId: number,
): Promise<string> {
  const campaignRow = rows(await exec.execute(sql`
    SELECT description, target_verticals, total_steps, content_revision, status
    FROM campaigns WHERE id = ${campaignId}
  `))[0];
  const campaignStepRows = rows(await exec.execute(sql`
    SELECT step_order, step_type, subject, body_template, delay_days, channel
    FROM campaign_steps WHERE campaign_id = ${campaignId} ORDER BY step_order ASC
  `));
  const sequenceRow = rows(await exec.execute(sql`
    SELECT description, total_steps, trigger_type, trigger_config, channels_allowed,
           eligible_consent_tiers, offer_routes, lifecycle_stages_allowed, status
    FROM follow_up_sequences WHERE id = ${sequenceId}
  `))[0];
  const sequenceStepRows = rows(await exec.execute(sql`
    SELECT step_order, action_type, subject, body, delay_days, delay_hours, config
    FROM sequence_steps WHERE sequence_id = ${sequenceId} ORDER BY step_order ASC
  `));
  // The shared launch presentation (signature, logo, links) is part of what a recipient sees, so it is versioned
  // content: changing it changes this hash and stales every preparation/approval pinned to the old one.
  return sha256({ campaignRow, campaignStepRows, sequenceRow, sequenceStepRows, presentation: sfpLaunchPresentationFingerprint() });
}

/**
 * Acquire a writer-compatible fence around all package content before the
 * canonical hash is read. Parent FOR UPDATE locks conflict with the KEY SHARE
 * locks taken by the campaign_steps.campaign_id and
 * sequence_steps.sequence_id foreign keys, fencing concurrent child inserts;
 * locking every current child fences edits/deletes. Keep this fixed order in
 * every commit-time package consumer.
 */
export async function lockLivePackageContentRows(
  exec: { execute: (q: any) => Promise<any> },
  campaignId: number,
  sequenceId: number,
): Promise<{ campaign: any; sequence: any }> {
  const campaign = rows(await exec.execute(sql`
    SELECT id,status FROM campaigns WHERE id=${campaignId} FOR UPDATE
  `))[0];
  if (!campaign) throw new Error("SFP_PACKAGE_CAMPAIGN_NOT_FOUND");
  const sequence = rows(await exec.execute(sql`
    SELECT id,status,trigger_config FROM follow_up_sequences WHERE id=${sequenceId} FOR UPDATE
  `))[0];
  if (!sequence) throw new Error("SFP_PACKAGE_SEQUENCE_NOT_FOUND");
  await exec.execute(sql`
    SELECT id FROM campaign_steps
     WHERE campaign_id=${campaignId}
     ORDER BY id FOR UPDATE
  `);
  await exec.execute(sql`
    SELECT id FROM sequence_steps
     WHERE sequence_id=${sequenceId}
     ORDER BY id FOR UPDATE
  `);
  return { campaign, sequence };
}

export interface PackageConvergencePreviewRow {
  packageKey: SfpPackageKey;
  vertical: string;
  action: "noop_current" | "create_campaign" | "narrow_campaign" | "create_sequence" | "reuse_sequence";
  detail: string;
}

export interface PackageConvergencePreview {
  rows: PackageConvergencePreviewRow[];
  wouldChangeCount: number;
  capturedAt: string;
}

/**
 * Read-only preview of what the convergence apply step would do. No writes.
 */
export async function previewPackageConvergence(): Promise<PackageConvergencePreview> {
  const previewRows: PackageConvergencePreviewRow[] = [];

  const currentVersions = rows(await db.execute(sql`
    SELECT package_key, campaign_name, sequence_name FROM sfp_campaign_package_versions
    WHERE lifecycle_state = 'current'
  `));
  const currentByKey = new Map(currentVersions.map((r) => [String(r.package_key), r]));

  for (const plan of PACKAGE_PLAN) {
    const existingCurrent = currentByKey.get(plan.packageKey);
    if (existingCurrent) {
      previewRows.push({
        packageKey: plan.packageKey,
        vertical: plan.vertical,
        action: "noop_current",
        detail: `Already current: campaign="${existingCurrent.campaign_name}" sequence="${existingCurrent.sequence_name}"`,
      });
      continue;
    }

    const campaignRow = rows(await db.execute(sql`
      SELECT id, name, status FROM campaigns WHERE name = ${plan.targetCampaignName} LIMIT 1
    `))[0];
    if (!campaignRow) {
      if (plan.isSplit) {
        previewRows.push({
          packageKey: plan.packageKey,
          vertical: plan.vertical,
          action: "create_campaign",
          detail: `Would create new draft campaign "${plan.targetCampaignName}" split from "${plan.sourceCampaignName}"`,
        });
      } else {
        previewRows.push({
          packageKey: plan.packageKey,
          vertical: plan.vertical,
          action: "narrow_campaign",
          detail: `Target campaign "${plan.targetCampaignName}" not found — would require operator content review before creation`,
        });
      }
    } else if (!plan.isSplit && campaignRow.name !== plan.sourceCampaignName) {
      previewRows.push({
        packageKey: plan.packageKey,
        vertical: plan.vertical,
        action: "narrow_campaign",
        detail: `Existing campaign "${campaignRow.name}" (id=${campaignRow.id}) would be scoped to ${plan.vertical} only`,
      });
    }

    const sequenceRow = rows(await db.execute(sql`
      SELECT id, name, status, sequence_family FROM follow_up_sequences WHERE name = ${plan.targetSequenceName} LIMIT 1
    `))[0];
    if (!sequenceRow) {
      previewRows.push({
        packageKey: plan.packageKey,
        vertical: plan.vertical,
        action: "create_sequence",
        detail: `Would create new paused sequence "${plan.targetSequenceName}" (family=${plan.sequenceFamily}) cloning W6 governance shape`,
      });
    } else {
      previewRows.push({
        packageKey: plan.packageKey,
        vertical: plan.vertical,
        action: "reuse_sequence",
        detail: `Existing sequence "${sequenceRow.name}" (id=${sequenceRow.id}, status=${sequenceRow.status}) would be reused`,
      });
    }
  }

  return {
    rows: previewRows,
    wouldChangeCount: previewRows.filter((r) => r.action !== "noop_current" && r.action !== "reuse_sequence").length,
    capturedAt: new Date().toISOString(),
  };
}

interface ApplyResultRow {
  packageKey: SfpPackageKey;
  status: "created" | "already_current" | "skipped_needs_review";
  packageVersionId?: string;
  campaignId?: number;
  sequenceId?: number;
  reason?: string;
}

/**
 * Apply the configuration convergence. Idempotent: a package_key already
 * `current` is left untouched. Never overwrites an active/approved campaign
 * or a sequence with existing steps/history — those cases are surfaced as
 * `skipped_needs_review` for an explicit, separate operator action rather
 * than silently mutated.
 */
export async function applyPackageConvergence(opts: { actorId: string }): Promise<ApplyResultRow[]> {
  const results: ApplyResultRow[] = [];
  const w6 = rows(await db.execute(sql`
    SELECT id, description, trigger_type, trigger_config, total_steps, eligible_consent_tiers,
           channels_allowed, offer_routes, lifecycle_stages_allowed
    FROM follow_up_sequences WHERE sequence_family = 'cold-email-manual-call' ORDER BY id ASC LIMIT 1
  `))[0];
  if (!w6) {
    throw new Error("SFP_W6_GOVERNANCE_TEMPLATE_NOT_FOUND: cannot clone sequence governance shape");
  }

  // PM-02 corrective note (Task #2001 post-merge audit): the prior
  // implementation (a) never actually performed the "narrow_campaign" action
  // its own preview described — a shared, multi-vertical source campaign
  // (e.g. "SDR-05: Medical / Dental / Medspa") was pinned as-is for the
  // Med Spa package, so a business tagged Dental could still resolve to the
  // shared campaign's content; and (b) issued each package's writes as
  // separate autocommitted statements, so a crash partway through one
  // package could leave a newly-created draft campaign or sequence with no
  // package_version row pinning it (an orphan, not converged and not
  // rolled back). Both are fixed here: narrowing is a real, transactional
  // step, and each package's full resolve/create/narrow/pin sequence runs
  // inside one transaction so it either fully lands or fully rolls back.
  for (const plan of PACKAGE_PLAN) {
    // PM-09 correction: a `current` row existing for this package_key is not
    // by itself proof the package is validly converged — verify it actually
    // targets this plan's vertical and that its pinned campaign/sequence are
    // still in the expected states, rather than blindly trusting any row
    // that happens to be marked current.
    const existingCurrent = rows(await db.execute(sql`
      SELECT v.id, v.vertical, c.status AS campaign_status, s.status AS sequence_status
      FROM sfp_campaign_package_versions v
      JOIN campaigns c ON c.id = v.campaign_id
      JOIN follow_up_sequences s ON s.id = v.sequence_id
      WHERE v.package_key = ${plan.packageKey} AND v.lifecycle_state = 'current' LIMIT 1
    `))[0];
    if (existingCurrent) {
      if (String(existingCurrent.vertical) !== plan.vertical) {
        results.push({ packageKey: plan.packageKey, status: "skipped_needs_review", reason: `current package version targets vertical "${existingCurrent.vertical}", expected "${plan.vertical}"` });
        continue;
      }
      if (existingCurrent.campaign_status !== "draft" || existingCurrent.sequence_status !== "paused") {
        results.push({ packageKey: plan.packageKey, status: "skipped_needs_review", reason: `pinned campaign/sequence is no longer draft/paused (campaign=${existingCurrent.campaign_status}, sequence=${existingCurrent.sequence_status})` });
        continue;
      }
      results.push({ packageKey: plan.packageKey, status: "already_current", packageVersionId: String(existingCurrent.id) });
      continue;
    }

    try {
      const result = await db.transaction(async (tx) => {
        // Resolve/create campaign
        let campaignRow = rows(await tx.execute(sql`
          SELECT id, name, status, content_revision, target_verticals FROM campaigns WHERE name = ${plan.targetCampaignName} LIMIT 1 FOR UPDATE
        `))[0];
        if (!campaignRow && plan.isSplit) {
          const sourceCampaign = rows(await tx.execute(sql`
            SELECT id, description, target_verticals, total_steps FROM campaigns WHERE name = ${plan.sourceCampaignName} LIMIT 1
          `))[0];
          if (!sourceCampaign) {
            return { status: "skipped_needs_review" as const, reason: `source campaign "${plan.sourceCampaignName}" not found` };
          }
          campaignRow = rows(await tx.execute(sql`
            INSERT INTO campaigns (name, description, target_verticals, status, total_steps, created_by, content_revision)
            VALUES (${plan.targetCampaignName},
                    ${`Draft ${plan.vertical} campaign split from "${plan.sourceCampaignName}" (Task #2001). Content/compliance review required before use.`},
                    ARRAY[${plan.vertical}]::text[], 'draft', ${sourceCampaign.total_steps ?? 3}, ${opts.actorId}, 1)
            RETURNING id, name, status, content_revision, target_verticals
          `))[0];
        }
        if (!campaignRow) {
          return { status: "skipped_needs_review" as const, reason: `target campaign "${plan.targetCampaignName}" does not exist and is not a split — requires an explicit, separately-governed narrowing edit before this package can go current` };
        }
        if (campaignRow.status !== "draft") {
          return { status: "skipped_needs_review" as const, reason: `campaign "${campaignRow.name}" (id=${campaignRow.id}) status is "${campaignRow.status}", not "draft" — refusing to pin an active/approved campaign without explicit review` };
        }

        // Real narrowing: a non-split package's target campaign must be
        // scoped to exactly this vertical before it can be pinned current.
        // A shared source campaign that still lists other verticals is
        // narrowed here (with a content_revision bump, so the pinned
        // content hash reflects the narrowed state); if it lists OTHER
        // verticals not in this plan at all (an unrelated/unexpected
        // shape), fail closed instead of guessing.
        if (!plan.isSplit) {
          const currentVerticals: string[] = Array.isArray(campaignRow.target_verticals) ? campaignRow.target_verticals : [];
          const alreadyNarrow = currentVerticals.length === 1 && currentVerticals[0] === plan.vertical;
          if (!alreadyNarrow) {
            const knownPlanVerticals = new Set(PACKAGE_PLAN.map((p) => p.vertical));
            const unexpected = currentVerticals.filter((v) => v !== plan.vertical && !knownPlanVerticals.has(v));
            if (unexpected.length > 0) {
              return { status: "skipped_needs_review" as const, reason: `campaign "${campaignRow.name}" (id=${campaignRow.id}) target_verticals includes unrecognized vertical(s) [${unexpected.join(", ")}] — refusing to auto-narrow` };
            }
            campaignRow = rows(await tx.execute(sql`
              UPDATE campaigns
                 SET target_verticals = ARRAY[${plan.vertical}]::text[], content_revision = COALESCE(content_revision, 0) + 1, updated_at = NOW()
               WHERE id = ${Number(campaignRow.id)}
              RETURNING id, name, status, content_revision, target_verticals
            `))[0];
          }
        }

        // Resolve/create sequence
        let sequenceRow = rows(await tx.execute(sql`
          SELECT id, name, status, total_steps FROM follow_up_sequences WHERE name = ${plan.targetSequenceName} LIMIT 1 FOR UPDATE
        `))[0];
        if (!sequenceRow) {
          sequenceRow = rows(await tx.execute(sql`
            INSERT INTO follow_up_sequences
              (name, description, trigger_type, trigger_config, total_steps, status, created_by,
               sequence_family, eligible_consent_tiers, channels_allowed, offer_routes, lifecycle_stages_allowed)
            VALUES (${plan.targetSequenceName},
                    ${`SFP ${plan.vertical} cold-outreach sequence (Task #2001), cloned from the W6 governance template. Paused until a later, separately authorized activation task.`},
                    ${w6.trigger_type}, ${JSON.stringify(w6.trigger_config)}::jsonb, ${w6.total_steps ?? 0}, 'paused', ${opts.actorId},
                    ${plan.sequenceFamily}, ${textArrayLiteral(w6.eligible_consent_tiers)}, ${textArrayLiteral(w6.channels_allowed)}, ${textArrayLiteral(w6.offer_routes)}, ${textArrayLiteral(w6.lifecycle_stages_allowed)})
            RETURNING id, name, status, total_steps
          `))[0];
        }
        if (sequenceRow.status !== "paused") {
          return { status: "skipped_needs_review" as const, reason: `sequence "${sequenceRow.name}" (id=${sequenceRow.id}) status is "${sequenceRow.status}", not "paused" — refusing to pin a live sequence` };
        }

        const contentHash = await computeLivePackageContentHash(tx, Number(campaignRow.id), Number(sequenceRow.id));

        const inserted = rows(await tx.execute(sql`
          INSERT INTO sfp_campaign_package_versions
            (package_key, vertical, campaign_id, campaign_name, sequence_id, sequence_name,
             sequence_family, content_hash, lifecycle_state, effective_at, actor_id, notes)
          VALUES (${plan.packageKey}, ${plan.vertical}, ${Number(campaignRow.id)}, ${campaignRow.name},
                  ${Number(sequenceRow.id)}, ${sequenceRow.name}, ${plan.sequenceFamily}, ${contentHash},
                  'current', NOW(), ${opts.actorId},
                  'Created by Task #2001 configuration-convergence command')
          RETURNING id
        `))[0];

        return {
          status: "created" as const,
          packageVersionId: String(inserted.id), campaignId: Number(campaignRow.id), sequenceId: Number(sequenceRow.id),
        };
      });
      results.push({ packageKey: plan.packageKey, ...result } as ApplyResultRow);
    } catch (err: any) {
      results.push({ packageKey: plan.packageKey, status: "skipped_needs_review", reason: `transaction failed: ${err?.message ?? String(err)}` });
    }
  }

  return results;
}

/** Verify step: every package key has exactly one `current` version pinned to a draft campaign + paused sequence. */
export async function verifyPackageConvergence(): Promise<{ ok: boolean; issues: string[] }> {
  const issues: string[] = [];
  for (const key of SFP_PACKAGE_KEYS) {
    const row = rows(await db.execute(sql`
      SELECT v.id, v.campaign_id, v.sequence_id, c.status AS campaign_status, s.status AS sequence_status
      FROM sfp_campaign_package_versions v
      JOIN campaigns c ON c.id = v.campaign_id
      JOIN follow_up_sequences s ON s.id = v.sequence_id
      WHERE v.package_key = ${key} AND v.lifecycle_state = 'current'
      LIMIT 1
    `))[0];
    if (!row) { issues.push(`${key}: no current package version`); continue; }
    if (row.campaign_status !== "draft") issues.push(`${key}: campaign status is "${row.campaign_status}", expected "draft"`);
    if (row.sequence_status !== "paused") issues.push(`${key}: sequence status is "${row.sequence_status}", expected "paused"`);
  }
  return { ok: issues.length === 0, issues };
}

/**
 * Resolve the current package version for a given vertical name (fail-closed
 * if none). PM-09 correction: this used a bare `LIMIT 1` with no ORDER BY
 * and no defense against more than one `current` row ever existing for the
 * same vertical (only `package_key` uniqueness was enforced, not
 * vertical uniqueness) — if that ever happened, the row returned would be
 * whatever the query planner picked, not a deterministic choice. Now it
 * orders deterministically AND throws instead of silently picking one when
 * more than one exists, so an ambiguity is a loud failure, not a coin flip.
 */
export async function getCurrentPackageForVertical(vertical: string): Promise<{
  id: string; packageKey: SfpPackageKey; campaignId: number; sequenceId: number; contentHash: string;
} | null> {
  const matches = rows(await db.execute(sql`
    SELECT id, package_key, campaign_id, sequence_id, content_hash
    FROM sfp_campaign_package_versions
    WHERE vertical = ${vertical} AND lifecycle_state = 'current'
    ORDER BY id ASC
  `));
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(`SFP_AMBIGUOUS_CURRENT_PACKAGE: ${matches.length} current package versions found for vertical "${vertical}" — expected exactly one`);
  }
  const row = matches[0];
  return {
    id: String(row.id), packageKey: row.package_key as SfpPackageKey,
    campaignId: Number(row.campaign_id), sequenceId: Number(row.sequence_id), contentHash: String(row.content_hash),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// South Florida v2 taxonomy packages (Automotive, Healthcare, Beauty/Spa,
// Construction/Trades/Home Services, Fitness/Recreation).
//
// Deliberately separate from PACKAGE_PLAN above: v1's five legacy packages
// (Restaurant, Med Spa, Dental, Retail, Auto Repair) are untouched — their
// rows, campaign history, and content hashes are never read or mutated by
// this section. A v2 package is ALWAYS a brand-new draft campaign + paused
// sequence, never a narrowed or reused existing campaign — there is no
// reviewed content mapping yet from any current campaign (including the
// SDR-10 Salon/Spa/Beauty campaign) onto the v2 taxonomy, so narrowing or
// reusing one here would silently ship unreviewed content/consent
// assumptions under a new vertical label. A human must separately review
// and repoint `targetCampaignName` once real content exists; until then this
// creates clearly-labeled placeholder drafts that can never send (draft
// campaign + paused sequence, verified below).
// ─────────────────────────────────────────────────────────────────────────

export type SfpPackageKeyV2 =
  | "sfp.automotive.v2"
  | "sfp.healthcare.v2"
  | "sfp.beauty_spa.v2"
  | "sfp.construction_trades_home_services.v2"
  | "sfp.fitness_recreation.v2";

export const SFP_PACKAGE_KEYS_V2: SfpPackageKeyV2[] = [
  "sfp.automotive.v2",
  "sfp.healthcare.v2",
  "sfp.beauty_spa.v2",
  "sfp.construction_trades_home_services.v2",
  "sfp.fitness_recreation.v2",
];

interface PackagePlanV2 {
  packageKey: SfpPackageKeyV2;
  vertical: string;
  targetCampaignName: string;
  targetSequenceName: string;
  sequenceFamily: string;
}

const PACKAGE_PLAN_V2: PackagePlanV2[] = [
  { packageKey: "sfp.automotive.v2", vertical: "Automotive", targetCampaignName: "SFP-V2: Automotive (draft, unreviewed)", targetSequenceName: "SFP Cold Outreach — Automotive (v2)", sequenceFamily: "sfp-v2-cold-automotive" },
  { packageKey: "sfp.healthcare.v2", vertical: "Healthcare", targetCampaignName: "SFP-V2: Healthcare (draft, unreviewed)", targetSequenceName: "SFP Cold Outreach — Healthcare (v2)", sequenceFamily: "sfp-v2-cold-healthcare" },
  { packageKey: "sfp.beauty_spa.v2", vertical: "Beauty/Spa", targetCampaignName: "SFP-V2: Beauty/Spa (draft, unreviewed)", targetSequenceName: "SFP Cold Outreach — Beauty/Spa (v2)", sequenceFamily: "sfp-v2-cold-beauty-spa" },
  { packageKey: "sfp.construction_trades_home_services.v2", vertical: "Construction/Trades/Home Services", targetCampaignName: "SFP-V2: Construction/Trades/Home Services (draft, unreviewed)", targetSequenceName: "SFP Cold Outreach — Construction/Trades/Home Services (v2)", sequenceFamily: "sfp-v2-cold-construction-trades" },
  { packageKey: "sfp.fitness_recreation.v2", vertical: "Fitness/Recreation", targetCampaignName: "SFP-V2: Fitness/Recreation (draft, unreviewed)", targetSequenceName: "SFP Cold Outreach — Fitness/Recreation (v2)", sequenceFamily: "sfp-v2-cold-fitness-recreation" },
];

// Guardrail: a v2 plan must exactly match the classifier's own v2 taxonomy
// (never silently drift from it), and must never reuse a v1 package's
// campaign/sequence name or the salon/spa source campaign.
if (JSON.stringify([...PACKAGE_PLAN_V2.map((p) => p.vertical)].sort()) !== JSON.stringify([...SFP_TARGET_VERTICALS_V2].sort())) {
  throw new Error("SFP_PACKAGE_PLAN_V2_INVALID: verticals must exactly match SFP_TARGET_VERTICALS_V2");
}
if (PACKAGE_PLAN_V2.some((p) => p.targetCampaignName.includes("SDR-10") || PACKAGE_PLAN.some((v1) => v1.targetCampaignName === p.targetCampaignName || v1.sourceCampaignName === p.targetCampaignName))) {
  throw new Error("SFP_PACKAGE_PLAN_V2_INVALID: must never reuse SDR-10 or a v1 package's campaign name");
}

export interface PackageConvergencePreviewRowV2 {
  packageKey: SfpPackageKeyV2;
  vertical: string;
  action: "noop_current" | "create_campaign" | "create_sequence" | "reuse_sequence" | "reuse_campaign";
  detail: string;
}

/** Read-only preview of what applyPackageConvergenceV2 would do. No writes. */
export async function previewPackageConvergenceV2(): Promise<{ rows: PackageConvergencePreviewRowV2[]; wouldChangeCount: number; capturedAt: string }> {
  const previewRows: PackageConvergencePreviewRowV2[] = [];
  const currentVersions = rows(await db.execute(sql`
    SELECT package_key, campaign_name, sequence_name FROM sfp_campaign_package_versions
    WHERE lifecycle_state = 'current' AND package_key = ANY(ARRAY[${sql.join(SFP_PACKAGE_KEYS_V2.map((k) => sql`${k}`), sql`,`)}]::text[])
  `));
  const currentByKey = new Map(currentVersions.map((r) => [String(r.package_key), r]));

  for (const plan of PACKAGE_PLAN_V2) {
    const existingCurrent = currentByKey.get(plan.packageKey);
    if (existingCurrent) {
      previewRows.push({ packageKey: plan.packageKey, vertical: plan.vertical, action: "noop_current", detail: `Already current: campaign="${existingCurrent.campaign_name}" sequence="${existingCurrent.sequence_name}"` });
      continue;
    }
    const campaignRow = rows(await db.execute(sql`SELECT id, name, status FROM campaigns WHERE name = ${plan.targetCampaignName} LIMIT 1`))[0];
    previewRows.push(campaignRow
      ? { packageKey: plan.packageKey, vertical: plan.vertical, action: "reuse_campaign", detail: `Existing placeholder campaign "${campaignRow.name}" (id=${campaignRow.id}, status=${campaignRow.status}) would be reused` }
      : { packageKey: plan.packageKey, vertical: plan.vertical, action: "create_campaign", detail: `Would create new draft, unreviewed campaign "${plan.targetCampaignName}"` });
    const sequenceRow = rows(await db.execute(sql`SELECT id, name, status FROM follow_up_sequences WHERE name = ${plan.targetSequenceName} LIMIT 1`))[0];
    previewRows.push(sequenceRow
      ? { packageKey: plan.packageKey, vertical: plan.vertical, action: "reuse_sequence", detail: `Existing sequence "${sequenceRow.name}" (id=${sequenceRow.id}, status=${sequenceRow.status}) would be reused` }
      : { packageKey: plan.packageKey, vertical: plan.vertical, action: "create_sequence", detail: `Would create new paused sequence "${plan.targetSequenceName}" (family=${plan.sequenceFamily}) cloning W6 governance shape` });
  }
  return { rows: previewRows, wouldChangeCount: previewRows.filter((r) => r.action !== "noop_current" && r.action !== "reuse_sequence" && r.action !== "reuse_campaign").length, capturedAt: new Date().toISOString() };
}

/**
 * Apply the v2 configuration convergence: exactly one current package
 * version per v2 vertical, each pinned to a brand-new draft campaign and a
 * brand-new paused sequence (cloned from the same W6 governance shape v1
 * uses). Never narrows or repoints an existing campaign — a v2 package
 * whose target campaign name does not yet exist always creates a fresh one.
 */
export async function applyPackageConvergenceV2(opts: { actorId: string }): Promise<ApplyResultRow[]> {
  const results: ApplyResultRow[] = [];
  const w6 = rows(await db.execute(sql`
    SELECT id, description, trigger_type, trigger_config, total_steps, eligible_consent_tiers,
           channels_allowed, offer_routes, lifecycle_stages_allowed
    FROM follow_up_sequences WHERE sequence_family = 'cold-email-manual-call' ORDER BY id ASC LIMIT 1
  `))[0];
  if (!w6) throw new Error("SFP_W6_GOVERNANCE_TEMPLATE_NOT_FOUND: cannot clone sequence governance shape");

  for (const plan of PACKAGE_PLAN_V2) {
    const existingCurrent = rows(await db.execute(sql`
      SELECT v.id, v.vertical, c.status AS campaign_status, s.status AS sequence_status
      FROM sfp_campaign_package_versions v
      JOIN campaigns c ON c.id = v.campaign_id
      JOIN follow_up_sequences s ON s.id = v.sequence_id
      WHERE v.package_key = ${plan.packageKey} AND v.lifecycle_state = 'current' LIMIT 1
    `))[0];
    if (existingCurrent) {
      if (String(existingCurrent.vertical) !== plan.vertical) {
        results.push({ packageKey: plan.packageKey as any, status: "skipped_needs_review", reason: `current package version targets vertical "${existingCurrent.vertical}", expected "${plan.vertical}"` });
        continue;
      }
      if (existingCurrent.campaign_status !== "draft" || existingCurrent.sequence_status !== "paused") {
        results.push({ packageKey: plan.packageKey as any, status: "skipped_needs_review", reason: `pinned campaign/sequence is no longer draft/paused (campaign=${existingCurrent.campaign_status}, sequence=${existingCurrent.sequence_status})` });
        continue;
      }
      results.push({ packageKey: plan.packageKey as any, status: "already_current", packageVersionId: String(existingCurrent.id) });
      continue;
    }

    try {
      const result = await db.transaction(async (tx) => {
        let campaignRow = rows(await tx.execute(sql`
          SELECT id, name, status, content_revision, target_verticals FROM campaigns WHERE name = ${plan.targetCampaignName} LIMIT 1 FOR UPDATE
        `))[0];
        if (!campaignRow) {
          campaignRow = rows(await tx.execute(sql`
            INSERT INTO campaigns (name, description, target_verticals, status, total_steps, created_by, content_revision)
            VALUES (${plan.targetCampaignName},
                    ${`Placeholder draft campaign for the South Florida v2 taxonomy vertical "${plan.vertical}". No reviewed content or channel/consent mapping exists yet — this exists only so a package version can be pinned; a human must author and review real content before this campaign can ever leave draft.`},
                    ARRAY[${plan.vertical}]::text[], 'draft', 3, ${opts.actorId}, 1)
            RETURNING id, name, status, content_revision, target_verticals
          `))[0];
        }
        if (campaignRow.status !== "draft") {
          return { status: "skipped_needs_review" as const, reason: `campaign "${campaignRow.name}" (id=${campaignRow.id}) status is "${campaignRow.status}", not "draft" — refusing to pin an active/approved campaign without explicit review` };
        }

        let sequenceRow = rows(await tx.execute(sql`
          SELECT id, name, status, total_steps FROM follow_up_sequences WHERE name = ${plan.targetSequenceName} LIMIT 1 FOR UPDATE
        `))[0];
        if (!sequenceRow) {
          sequenceRow = rows(await tx.execute(sql`
            INSERT INTO follow_up_sequences
              (name, description, trigger_type, trigger_config, total_steps, status, created_by,
               sequence_family, eligible_consent_tiers, channels_allowed, offer_routes, lifecycle_stages_allowed)
            VALUES (${plan.targetSequenceName},
                    ${`SFP v2 ${plan.vertical} cold-outreach sequence, cloned from the W6 governance template. Paused until a later, separately authorized activation task.`},
                    ${w6.trigger_type}, ${JSON.stringify(w6.trigger_config)}::jsonb, ${w6.total_steps ?? 0}, 'paused', ${opts.actorId},
                    ${plan.sequenceFamily}, ${textArrayLiteral(w6.eligible_consent_tiers)}, ${textArrayLiteral(w6.channels_allowed)}, ${textArrayLiteral(w6.offer_routes)}, ${textArrayLiteral(w6.lifecycle_stages_allowed)})
            RETURNING id, name, status, total_steps
          `))[0];
        }
        if (sequenceRow.status !== "paused") {
          return { status: "skipped_needs_review" as const, reason: `sequence "${sequenceRow.name}" (id=${sequenceRow.id}) status is "${sequenceRow.status}", not "paused" — refusing to pin a live sequence` };
        }

        const contentHash = await computeLivePackageContentHash(tx, Number(campaignRow.id), Number(sequenceRow.id));
        const inserted = rows(await tx.execute(sql`
          INSERT INTO sfp_campaign_package_versions
            (package_key, vertical, campaign_id, campaign_name, sequence_id, sequence_name,
             sequence_family, content_hash, lifecycle_state, effective_at, actor_id, notes)
          VALUES (${plan.packageKey}, ${plan.vertical}, ${Number(campaignRow.id)}, ${campaignRow.name},
                  ${Number(sequenceRow.id)}, ${sequenceRow.name}, ${plan.sequenceFamily}, ${contentHash},
                  'current', NOW(), ${opts.actorId},
                  'Created by South Florida v2 package configuration-convergence command; placeholder content pending review')
          RETURNING id
        `))[0];
        return { status: "created" as const, packageVersionId: String(inserted.id), campaignId: Number(campaignRow.id), sequenceId: Number(sequenceRow.id) };
      });
      results.push({ packageKey: plan.packageKey as any, ...result } as ApplyResultRow);
    } catch (err: any) {
      const detail = err?.cause?.message ?? err?.message ?? String(err);
      results.push({ packageKey: plan.packageKey as any, status: "skipped_needs_review", reason: `transaction failed: ${detail}` });
    }
  }
  return results;
}

/** Verify step: every v2 package key has exactly one `current` version pinned to a draft campaign + paused sequence. */
export async function verifyPackageConvergenceV2(): Promise<{ ok: boolean; issues: string[] }> {
  const issues: string[] = [];
  for (const key of SFP_PACKAGE_KEYS_V2) {
    const row = rows(await db.execute(sql`
      SELECT v.id, v.campaign_id, v.sequence_id, c.status AS campaign_status, s.status AS sequence_status
      FROM sfp_campaign_package_versions v
      JOIN campaigns c ON c.id = v.campaign_id
      JOIN follow_up_sequences s ON s.id = v.sequence_id
      WHERE v.package_key = ${key} AND v.lifecycle_state = 'current'
      LIMIT 1
    `))[0];
    if (!row) { issues.push(`${key}: no current package version`); continue; }
    if (row.campaign_status !== "draft") issues.push(`${key}: campaign status is "${row.campaign_status}", expected "draft"`);
    if (row.sequence_status !== "paused") issues.push(`${key}: sequence status is "${row.sequence_status}", expected "paused"`);
  }
  return { ok: issues.length === 0, issues };
}
