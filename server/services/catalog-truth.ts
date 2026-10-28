/**
 * Derived, read-only catalog contract (Stage 4A).
 *
 * Classification derives from real package pins (sfp_campaign_package_versions) and retired_at columns. It never
 * reads status or a name to decide whether an asset is current, retired or a template, and it never hard-codes
 * campaign or sequence ids. A failed read produces "unavailable", never an empty or zero catalog.
 */
import { sql } from "drizzle-orm";
import { db } from "../db";
import { CRO07_PRODUCTION_CONNECTED } from "./cro07-release-authority";

export type CatalogClass = "current" | "template" | "historical" | "uninstalled" | "unresolved";
export type ReadinessValue = "yes" | "no" | "unavailable";
export interface ReadinessFact { state: ReadinessValue; basis: string }
export interface CatalogReadiness {
  configured: ReadinessFact;
  selected: ReadinessFact;
  qualified: ReadinessFact;
  paused: ReadinessFact;
  operating: ReadinessFact;
  nativeEffectVerified: ReadinessFact;
}

export interface PackageVersionRow {
  id: string; packageKey: string; vertical: string; campaignId: number; sequenceId: number;
  lifecycleState: "draft" | "current" | "superseded" | "retired" | string;
}
export interface AssetRow { id: number; name: string; status: string | null; retiredAt: string | null; stepCount?: number | null; approvedRevision?: number | null; contentRevision?: number | null }

export interface CatalogAsset {
  kind: "campaign" | "sequence";
  id: number;
  name: string;
  catalogClass: CatalogClass;
  reason: string;
  /** Package versions that pin this asset (any lifecycle). */
  pinnedBy: { packageVersionId: string; packageKey: string; lifecycleState: string }[];
  retiredAt: string | null;
}

export interface CatalogPackage {
  packageKey: string;
  vertical: string;
  packageVersionId: string;
  lifecycleState: string;
  catalogClass: CatalogClass;
  campaignId: number;
  sequenceId: number;
  pinsResolved: boolean;
  readiness: CatalogReadiness;
}

export interface CatalogTruth {
  asOf: string;
  scope: "full_catalog_whole_population";
  available: boolean;
  unavailableReason: string | null;
  packages: CatalogPackage[];
  campaigns: CatalogAsset[];
  sequences: CatalogAsset[];
  /** Plan entries with no installed package row. Empty when the plan source is not supplied. */
  uninstalledPackageKeys: string[];
  counts: Record<CatalogClass, number> | null;
  cr06: { governedArtifacts: number | null; state: "empty" | "populated" | "unavailable"; note: string };
  cro07: { productionConnected: boolean; note: string };
  /** status='active' sequences are reported as a raw count only and are never readiness proof. */
  statusActiveSequences: { count: number | null; note: string };
}

export interface CatalogInput {
  packages: PackageVersionRow[];
  campaigns: AssetRow[];
  sequences: AssetRow[];
  plannedPackageKeys?: string[];
  cr06GovernedArtifacts: number | null;
  globalPauseState: "paused" | "activating" | "unpaused" | "unavailable";
  statusActiveSequences: number | null;
  asOf?: string;
}

function classOfPackage(state: string): CatalogClass {
  if (state === "current") return "current";
  if (state === "draft") return "template";
  return "historical"; // superseded, retired
}

// Higher rank wins when an asset is pinned by several package versions.
const RANK: Record<CatalogClass, number> = { current: 4, template: 3, historical: 2, uninstalled: 1, unresolved: 0 };

/** Shared pin-to-class rule for callers that only hold lifecycle states (no I/O). */
export function catalogClassForPins(pinLifecycleStates: string[], retired: boolean): CatalogClass {
  if (pinLifecycleStates.length === 0) return retired ? "historical" : "unresolved";
  const best = pinLifecycleStates.map(classOfPackage).sort((x, y) => RANK[y] - RANK[x])[0];
  if (best === "current" && retired) return "unresolved";
  return best;
}

function classifyAsset(kind: "campaign" | "sequence", a: AssetRow, packages: PackageVersionRow[]): CatalogAsset {
  const pins = packages.filter((p) => (kind === "campaign" ? p.campaignId === a.id : p.sequenceId === a.id));
  const pinnedBy = pins.map((p) => ({ packageVersionId: p.id, packageKey: p.packageKey, lifecycleState: p.lifecycleState }));
  const base = { kind, id: a.id, name: a.name, pinnedBy, retiredAt: a.retiredAt };
  if (pins.length === 0) {
    if (a.retiredAt) return { ...base, catalogClass: "historical", reason: "retired_at is set and no package pins it" };
    return { ...base, catalogClass: "unresolved", reason: "no package version owns this asset; it is not proven current, template or historical" };
  }
  const best = pins.map((p) => classOfPackage(p.lifecycleState)).sort((x, y) => RANK[y] - RANK[x])[0];
  if (best === "current" && a.retiredAt) {
    return { ...base, catalogClass: "unresolved", reason: "a current package pins an asset whose retired_at is set (pin conflict)" };
  }
  const reasons: Record<CatalogClass, string> = {
    current: "pinned by the current package version",
    template: "pinned only by a draft package version",
    historical: "pinned only by superseded or retired package versions",
    uninstalled: "",
    unresolved: "",
  };
  return { ...base, catalogClass: best, reason: reasons[best] };
}

function readinessFor(
  pkg: PackageVersionRow, campaign: AssetRow | undefined, sequence: AssetRow | undefined,
  pause: CatalogInput["globalPauseState"], currentForVertical: number,
): CatalogReadiness {
  const pinsResolved = !!campaign && !!sequence;
  const configured: ReadinessFact = pinsResolved
    ? { state: "yes", basis: "campaign and sequence pins resolve in their tables" }
    : { state: "no", basis: "a pinned campaign or sequence row is missing" };
  const selected: ReadinessFact = pkg.lifecycleState !== "current"
    ? { state: "no", basis: `package version is ${pkg.lifecycleState}, not current` }
    : currentForVertical === 1 ? { state: "yes", basis: "exactly one current package version for this vertical" }
    : { state: "no", basis: `${currentForVertical} current package versions for this vertical` };
  let qualified: ReadinessFact;
  if (!pinsResolved) qualified = { state: "no", basis: "pins unresolved" };
  else if (sequence!.stepCount == null || campaign!.approvedRevision === undefined) qualified = { state: "unavailable", basis: "step count or approval revision was not read" };
  else if ((sequence!.stepCount ?? 0) < 1) qualified = { state: "no", basis: "sequence has no steps" };
  else if (campaign!.approvedRevision == null || campaign!.approvedRevision !== campaign!.contentRevision) qualified = { state: "no", basis: "campaign content revision is not approved" };
  else qualified = { state: "yes", basis: "sequence has steps and the campaign approved revision matches content revision" };
  const paused: ReadinessFact = !sequence ? { state: "unavailable", basis: "sequence row missing" }
    : sequence.status === "paused" ? { state: "yes", basis: "sequence status is paused" }
    : { state: "no", basis: `sequence status is ${sequence.status ?? "unknown"}` };
  let operating: ReadinessFact;
  if (pause === "unavailable") operating = { state: "unavailable", basis: "global pause state could not be read" };
  else if (pause !== "unpaused") operating = { state: "no", basis: `global outbound state is ${pause}` };
  else if (sequence?.status === "active" && campaign?.status === "active") operating = { state: "yes", basis: "global outbound unpaused and sequence and campaign status active" };
  else operating = { state: "no", basis: "sequence or campaign is not active" };
  const nativeEffectVerified: ReadinessFact = CRO07_PRODUCTION_CONNECTED
    ? { state: "unavailable", basis: "no native-effect receipt reader is wired into this catalog" }
    : { state: "unavailable", basis: "CRO-07 production transport is disconnected; native effects are unverified by design" };
  return { configured, selected, qualified, paused, operating, nativeEffectVerified };
}

/** Pure derivation: no I/O, so each state is testable. */
export function buildCatalogTruth(input: CatalogInput): CatalogTruth {
  const campaignsById = new Map(input.campaigns.map((c) => [c.id, c]));
  const sequencesById = new Map(input.sequences.map((s) => [s.id, s]));
  const currentByVertical = new Map<string, number>();
  for (const p of input.packages) if (p.lifecycleState === "current") currentByVertical.set(p.vertical, (currentByVertical.get(p.vertical) ?? 0) + 1);

  const packages: CatalogPackage[] = input.packages.map((p) => {
    const campaign = campaignsById.get(p.campaignId);
    const sequence = sequencesById.get(p.sequenceId);
    return {
      packageKey: p.packageKey, vertical: p.vertical, packageVersionId: p.id, lifecycleState: p.lifecycleState,
      catalogClass: classOfPackage(p.lifecycleState), campaignId: p.campaignId, sequenceId: p.sequenceId,
      pinsResolved: !!campaign && !!sequence,
      readiness: readinessFor(p, campaign, sequence, input.globalPauseState, currentByVertical.get(p.vertical) ?? 0),
    };
  });
  const campaigns = input.campaigns.map((c) => classifyAsset("campaign", c, input.packages));
  const sequences = input.sequences.map((s) => classifyAsset("sequence", s, input.packages));
  const installedKeys = new Set(input.packages.map((p) => p.packageKey));
  const uninstalledPackageKeys = (input.plannedPackageKeys ?? []).filter((k) => !installedKeys.has(k));

  const counts: Record<CatalogClass, number> = { current: 0, template: 0, historical: 0, uninstalled: uninstalledPackageKeys.length, unresolved: 0 };
  for (const a of [...campaigns, ...sequences]) counts[a.catalogClass]++;

  const cr06 = input.cr06GovernedArtifacts == null
    ? { governedArtifacts: null, state: "unavailable" as const, note: "CR-06 artifact count could not be read" }
    : input.cr06GovernedArtifacts === 0
      ? { governedArtifacts: 0, state: "empty" as const, note: "No CR-06 governed artifacts exist. Verified current SFP packages are not legacy because of that." }
      : { governedArtifacts: input.cr06GovernedArtifacts, state: "populated" as const, note: "CR-06 governed artifacts exist." };

  return {
    asOf: input.asOf ?? new Date().toISOString(),
    scope: "full_catalog_whole_population",
    available: true,
    unavailableReason: null,
    packages, campaigns, sequences, uninstalledPackageKeys, counts, cr06,
    cro07: {
      productionConnected: CRO07_PRODUCTION_CONNECTED,
      note: CRO07_PRODUCTION_CONNECTED ? "CRO-07 production transport is connected." : "CRO-07 production transport is disconnected; this stays scoped and is not a catalog defect.",
    },
    statusActiveSequences: {
      count: input.statusActiveSequences,
      note: "Raw count of sequences with status 'active'. Status is not readiness proof; use the package readiness states.",
    },
  };
}

const rows = (r: any): any[] => r?.rows ?? r ?? [];

/** Reads the catalog from the tables. Any failed read yields an explicit unavailable result. */
export async function loadCatalogTruth(): Promise<CatalogTruth> {
  const asOf = new Date().toISOString();
  const unavailable = (reason: string): CatalogTruth => ({
    asOf, scope: "full_catalog_whole_population", available: false, unavailableReason: reason,
    packages: [], campaigns: [], sequences: [], uninstalledPackageKeys: [], counts: null,
    cr06: { governedArtifacts: null, state: "unavailable", note: "not read" },
    cro07: { productionConnected: CRO07_PRODUCTION_CONNECTED, note: "not read" },
    statusActiveSequences: { count: null, note: "not read" },
  });
  try {
    const [pk, camps, seqs, steps] = await Promise.all([
      db.execute(sql`SELECT id::text AS id, package_key, vertical, campaign_id, sequence_id, lifecycle_state FROM sfp_campaign_package_versions ORDER BY created_at, id`),
      db.execute(sql`SELECT id, name, status, approved_revision, content_revision FROM campaigns ORDER BY id`),
      db.execute(sql`SELECT id, name, status, retired_at FROM follow_up_sequences ORDER BY id`),
      // Grouped step totals: never the stale total_steps column.
      db.execute(sql`SELECT sequence_id, COUNT(*)::int AS n FROM sequence_steps GROUP BY sequence_id`),
    ]);
    const stepCounts = new Map<number, number>(rows(steps).map((r) => [Number(r.sequence_id), Number(r.n)]));
    let cr06: number | null = null;
    try {
      cr06 = Number(rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM cr06_artifacts WHERE retired_at IS NULL`))[0]?.n ?? 0);
    } catch { cr06 = null; }
    let pause: CatalogInput["globalPauseState"] = "unavailable";
    try {
      const { getPauseState } = await import("./outbound-pause-authority");
      const st = await getPauseState();
      pause = st.source === "database" ? st.state : "unavailable";
    } catch { pause = "unavailable"; }
    let planned: string[] | undefined;
    try {
      const mod = await import("./cro03/sfp-campaign-packages");
      planned = [...((mod as any).SFP_PACKAGE_KEYS ?? []), ...mod.SFP_PACKAGE_KEYS_V2];
    } catch { planned = undefined; }
    const activeCount = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM follow_up_sequences WHERE status = 'active'`))[0]?.n;
    return buildCatalogTruth({
      packages: rows(pk).map((r) => ({
        id: String(r.id), packageKey: String(r.package_key), vertical: String(r.vertical),
        campaignId: Number(r.campaign_id), sequenceId: Number(r.sequence_id), lifecycleState: String(r.lifecycle_state),
      })),
      campaigns: rows(camps).map((r) => ({
        id: Number(r.id), name: String(r.name), status: r.status ?? null, retiredAt: null,
        approvedRevision: r.approved_revision == null ? null : Number(r.approved_revision), contentRevision: Number(r.content_revision),
      })),
      sequences: rows(seqs).map((r) => ({
        id: Number(r.id), name: String(r.name), status: r.status ?? null,
        retiredAt: r.retired_at ? new Date(r.retired_at).toISOString() : null, stepCount: stepCounts.get(Number(r.id)) ?? 0,
      })),
      plannedPackageKeys: planned,
      cr06GovernedArtifacts: cr06,
      globalPauseState: pause,
      statusActiveSequences: activeCount == null ? null : Number(activeCount),
      asOf,
    });
  } catch (err: any) {
    return unavailable(String(err?.code ?? err?.message ?? "catalog_read_failed").slice(0, 120));
  }
}
