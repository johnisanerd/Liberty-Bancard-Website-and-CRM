import { randomUUID } from "node:crypto";
import { pool } from "../db";
import { getBackgroundProfile, getSelectiveGroups } from "./background-profile";
import { QUEUE_NAMES } from "./queue-names";
import { resolveRoutineSfpDeploymentIdentity } from "../../shared/sfp-publish-build-identity";

const OWNER_SETTING_KEY = "ghl_sync_runtime_owner";
const GHL_SYNC_OWNER_PROFILE = "ghl-sync-only";
const LEASE_TTL_MS = 90_000;
const HEARTBEAT_MS = 20_000;

type GhlControlSnapshot = {
  enabled: boolean;
  permissionsEnabled: boolean;
  epoch: number | string;
  ownerProfile: string | null;
  selectedRuntime: string | null;
  nativeReview: unknown;
};

export interface GhlSyncRuntimeBinding {
  /** Stable isolated capability owner, distinct from processProfile. */
  profile: string;
  processProfile: string;
  releaseSha: string | null;
  deploymentIdentity: string;
  processIdentity: string;
  environment: string;
  selectedRuntime: string;
  controlOwnerProfile: string;
  epoch: number | string;
}

type DurableOwner = GhlSyncRuntimeBinding & {
  leaseToken: string;
  heartbeatAt: string;
  leaseExpiresAt: string;
  state: "running" | "released";
};

let activeOwnerToken: string | null = null;

async function getControl(): Promise<GhlControlSnapshot> {
  const { getGhlSyncControl } = await import("./ghl-sync-control");
  return getGhlSyncControl();
}

function processIdentity(): string {
  return process.env.PROCESS_IDENTITY || `${process.env.HOSTNAME || "unknown-host"}:${process.pid}`;
}

function runtimeBinding(control: GhlControlSnapshot) {
  return {
    profile: GHL_SYNC_OWNER_PROFILE,
    processProfile: process.env.BACKGROUND_JOB_PROFILE ?? "off",
    releaseSha: process.env.RELEASE_SHA ?? null,
    deploymentIdentity: currentRoutineDeploymentIdentity() || "unknown-deployment",
    processIdentity: processIdentity(),
    environment: process.env.NODE_ENV ?? "unknown",
    selectedRuntime: control.selectedRuntime ?? "",
    controlOwnerProfile: control.ownerProfile ?? "",
    epoch: control.epoch,
  };
}

export function isGhlSyncRuntimeSelectionValid(input: {
  globalProfile: string;
  selectiveGroups: string[];
  controlEnabled: boolean;
  controlOwnerProfile: string | null;
  controlSelectedRuntime: string | null;
  expectedRuntime: string | null;
  ownerProfileEnv?: string;
}): boolean {
  return getGhlSyncRuntimeSelectionStatus(input) === "selected";
}

export function getGhlSyncRuntimeSelectionStatus(input: {
  globalProfile: string;
  selectiveGroups: string[];
  controlEnabled: boolean;
  controlOwnerProfile: string | null;
  controlSelectedRuntime: string | null;
  expectedRuntime: string | null;
  ownerProfileEnv?: string;
}): "selected" | "control_disabled" | "owner_profile_mismatch" | "runtime_identity_unresolved" | "selected_runtime_mismatch" | "owner_profile_env_mismatch" | "needs_isolated_group" {
  if (input.controlEnabled !== true) return "control_disabled";
  if (input.controlOwnerProfile !== GHL_SYNC_OWNER_PROFILE) return "owner_profile_mismatch";
  if (!input.expectedRuntime) return "runtime_identity_unresolved";
  if (input.controlSelectedRuntime !== input.expectedRuntime) return "selected_runtime_mismatch";
  if (input.ownerProfileEnv && input.ownerProfileEnv !== GHL_SYNC_OWNER_PROFILE) return "owner_profile_env_mismatch";
  const isolatedCapabilitySelected = input.globalProfile === GHL_SYNC_OWNER_PROFILE
    || (input.globalProfile === "selective" && input.selectiveGroups.includes(GHL_SYNC_OWNER_PROFILE));
  return isolatedCapabilitySelected ? "selected" : "needs_isolated_group";
}

function currentRoutineDeploymentIdentity(): string | null {
  return resolveRoutineSfpDeploymentIdentity({
    releaseSha: process.env.RELEASE_SHA,
    publishArtifactSha: process.env.SFP_PUBLISH_ARTIFACT_SHA,
    publishBuildId: process.env.SFP_PUBLISH_BUILD_ID,
    platformDeploymentId: process.env.REPL_DEPLOYMENT_ID,
  });
}

function runtimeSelectionMatches(control: GhlControlSnapshot): boolean {
  return getRuntimeSelectionState(control) === "selected";
}

function getRuntimeSelectionState(control: GhlControlSnapshot): string {
  const expectedRuntime = currentRoutineDeploymentIdentity();
  return getGhlSyncRuntimeSelectionStatus({
    globalProfile: process.env.BACKGROUND_JOB_PROFILE ?? "off",
    selectiveGroups: getSelectiveGroups(),
    controlEnabled: control.enabled,
    controlOwnerProfile: control.ownerProfile,
    controlSelectedRuntime: control.selectedRuntime,
    expectedRuntime,
    ownerProfileEnv: process.env.GHL_OWNER_PROFILE,
  });
}

function decodeOwner(value: unknown): DurableOwner | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const owner = value as Partial<DurableOwner>;
  if (
    typeof owner.leaseToken !== "string"
    || typeof owner.profile !== "string"
    || typeof owner.processProfile !== "string"
    || typeof owner.deploymentIdentity !== "string"
    || typeof owner.processIdentity !== "string"
    || typeof owner.environment !== "string"
    || typeof owner.selectedRuntime !== "string"
    || typeof owner.controlOwnerProfile !== "string"
    || (typeof owner.epoch !== "string" && typeof owner.epoch !== "number")
    || typeof owner.heartbeatAt !== "string"
    || typeof owner.leaseExpiresAt !== "string"
    || (owner.state !== "running" && owner.state !== "released")
  ) return null;
  return owner as DurableOwner;
}

async function readDurableOwner(): Promise<DurableOwner | null> {
  const result = await pool.query<{ value: unknown }>(
    "SELECT value FROM system_settings WHERE key = $1 LIMIT 1",
    [OWNER_SETTING_KEY],
  );
  const value = result.rows[0]?.value;
  if (typeof value === "string") {
    try { return decodeOwner(JSON.parse(value)); } catch { return null; }
  }
  return decodeOwner(value);
}

export function isGhlSyncRuntimeOwnerFenceCurrent(owner: GhlSyncRuntimeBinding, binding: GhlSyncRuntimeBinding): boolean {
  return owner.profile === binding.profile
    && owner.processProfile === binding.processProfile
    && owner.releaseSha === binding.releaseSha
    && owner.deploymentIdentity === binding.deploymentIdentity
    && owner.processIdentity === binding.processIdentity
    && owner.environment === binding.environment
    && owner.selectedRuntime === binding.selectedRuntime
    && owner.controlOwnerProfile === binding.controlOwnerProfile
    && String(owner.epoch) === String(binding.epoch);
}

function sameBinding(owner: DurableOwner, binding: ReturnType<typeof runtimeBinding>): boolean {
  return isGhlSyncRuntimeOwnerFenceCurrent(owner, binding);
}

export type GhlSyncRuntimeLease = {
  status: "acquired" | "held" | "unavailable" | "not_selected";
  leaseToken?: string;
  assertOwned?: () => Promise<void>;
  stopHeartbeat?: () => void;
  release?: () => Promise<void>;
};

/** Durable singleton lease for GHL sync, independent of SFP runtime ownership. */
export async function acquireGhlSyncRuntimeLease(): Promise<GhlSyncRuntimeLease> {
  let control: GhlControlSnapshot;
  try {
    control = await getControl();
  } catch {
    return { status: "unavailable" };
  }
  if (!runtimeSelectionMatches(control)) return { status: "not_selected" };

  const binding = runtimeBinding(control);
  const leaseToken = randomUUID();
  const now = new Date();
  const owner: DurableOwner = {
    ...binding,
    leaseToken,
    heartbeatAt: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + LEASE_TTL_MS).toISOString(),
    state: "running",
  };
  try {
    const result = await pool.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW()
       WHERE COALESCE(
         (system_settings.value->>'leaseExpiresAt')::timestamptz,
         to_timestamp(0)
       ) <= NOW()
          OR (
            system_settings.value->>'leaseToken' = $3
            AND system_settings.value->>'state' = 'running'
          )
       RETURNING value`,
      [OWNER_SETTING_KEY, JSON.stringify(owner), leaseToken],
    );
    if ((result.rowCount ?? 0) !== 1) return { status: "held" };
    activeOwnerToken = leaseToken;
  } catch {
    return { status: "unavailable" };
  }

  let lost = false;
  const heartbeat = async (): Promise<boolean> => {
    try {
      const currentControl = await getControl();
      if (!runtimeSelectionMatches(currentControl)
        || String(currentControl.epoch) !== String(binding.epoch)
        || currentControl.selectedRuntime !== binding.selectedRuntime) return false;
      const heartbeatAt = new Date();
      const currentOwner = { ...owner, heartbeatAt: heartbeatAt.toISOString(), leaseExpiresAt: new Date(heartbeatAt.getTime() + LEASE_TTL_MS).toISOString() };
      const result = await pool.query(
        `UPDATE system_settings
         SET value = $2::jsonb, updated_at = NOW()
         WHERE key = $1
           AND value->>'leaseToken' = $3
           AND value->>'state' = 'running'
           AND (value->>'leaseExpiresAt')::timestamptz > NOW()`,
        [OWNER_SETTING_KEY, JSON.stringify(currentOwner), leaseToken],
      );
      if ((result.rowCount ?? 0) !== 1) return false;
      Object.assign(owner, currentOwner);
      return true;
    } catch {
      return false;
    }
  };
  const timer = setInterval(() => {
    heartbeat().then((owned) => { if (!owned) lost = true; }).catch(() => { lost = true; });
  }, HEARTBEAT_MS);
  timer.unref?.();

  return {
    status: "acquired",
    leaseToken,
    assertOwned: async () => {
      if (lost || activeOwnerToken !== leaseToken) throw new Error("GHL_SYNC_RUNTIME_LEASE_LOST");
      const currentControl = await getControl();
      if (!runtimeSelectionMatches(currentControl)
        || String(currentControl.epoch) !== String(binding.epoch)
        || currentControl.selectedRuntime !== binding.selectedRuntime) {
        lost = true;
        throw new Error("GHL_SYNC_RUNTIME_SELECTION_CHANGED");
      }
      const currentOwner = await readDurableOwner();
      if (!currentOwner || currentOwner.leaseToken !== leaseToken || !sameBinding(currentOwner, binding)
        || new Date(currentOwner.leaseExpiresAt).getTime() <= Date.now()) {
        lost = true;
        throw new Error("GHL_SYNC_RUNTIME_LEASE_LOST");
      }
    },
    stopHeartbeat: () => clearInterval(timer),
    release: async () => {
      clearInterval(timer);
      if (activeOwnerToken === leaseToken) activeOwnerToken = null;
      try {
        const releasedAt = new Date();
        const released = { ...owner, heartbeatAt: releasedAt.toISOString(), leaseExpiresAt: releasedAt.toISOString(), state: "released" as const };
        await pool.query(
          `UPDATE system_settings SET value = $2::jsonb, updated_at = NOW()
           WHERE key = $1 AND value->>'leaseToken' = $3`,
          [OWNER_SETTING_KEY, JSON.stringify(released), leaseToken],
        );
      } catch {
        // Expiry is the recovery path if release cannot be persisted.
      }
    },
  };
}

export interface GhlSyncRuntimeTruth {
  owner: {
    profile: string | null;
    processProfile: string | null;
    releaseSha: string | null;
    deploymentIdentity: string | null;
    processIdentity: string | null;
    heartbeatAt: string | null;
    heartbeatFresh: boolean | null;
    leaseExpiresAt: string | null;
    state: string;
  };
  worker: { selected: boolean; active: boolean; profile: string; state: string };
  queueBacklog: { waiting: number; active: number; delayed: number; failed: number } | null;
  metrics: {
    currentEntityCounts: { contacts: unknown; deals: unknown; providerProjections: unknown } | null;
    historicEntityCounts: Record<string, { syncedCount: number; errorCount: number }> | null;
  };
  blockedDeferred: { count: number; lastAt: string | null; lastEntityType: string | null; lastReason: string | null } | null;
  exportBacklog: (import("./ghl-projection-authority").ProjectionBacklog & { oldestEligibleAt: string | null; oldestHeldAt: string | null; asOf: string }) | null;
  lastTick: Record<string, unknown> | null;
  exportPolicy: { currentIntakeSince: string | null; legacyPhases: Record<string, boolean> | null } | null;
  errors: { owner: string | null; worker: string | null; queueBacklog: string | null; metrics: string | null; deferred: string | null; exportBacklog?: string | null };
}

/** Read-only operational truth; unknown database/queue values stay null. */
export async function getGhlSyncRuntimeTruth(): Promise<GhlSyncRuntimeTruth> {
  const profile = getBackgroundProfile();
  const truth: GhlSyncRuntimeTruth = {
    owner: { profile: null, processProfile: null, releaseSha: null, deploymentIdentity: null, processIdentity: null, heartbeatAt: null, heartbeatFresh: null, leaseExpiresAt: null, state: "unknown" },
    worker: { selected: false, active: false, profile, state: "unknown" },
    queueBacklog: null,
    metrics: { currentEntityCounts: null, historicEntityCounts: null },
    blockedDeferred: null,
    exportBacklog: null,
    lastTick: null,
    exportPolicy: null,
    errors: { owner: null, worker: null, queueBacklog: null, metrics: null, deferred: null },
  };
  try {
    const control = await getControl();
    const owner = await readDurableOwner();
    if (owner) {
      const binding = runtimeBinding(control);
      const expiresAt = new Date(owner.leaseExpiresAt).getTime();
      const heartbeatAt = new Date(owner.heartbeatAt).getTime();
      const heartbeatFresh = Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt <= LEASE_TTL_MS;
      const current = sameBinding(owner, binding) && runtimeSelectionMatches(control) && owner.state === "running";
      truth.owner = {
        profile: owner.profile,
        processProfile: owner.processProfile,
        releaseSha: owner.releaseSha,
        deploymentIdentity: owner.deploymentIdentity,
        processIdentity: owner.processIdentity,
        heartbeatAt: owner.heartbeatAt,
        heartbeatFresh: current ? heartbeatFresh : false,
        leaseExpiresAt: owner.leaseExpiresAt,
        state: current && heartbeatFresh && expiresAt > Date.now() ? "current" : owner.state === "released" ? "released" : "stale_or_mismatched",
      };
    } else {
      const selectionState = getRuntimeSelectionState(control);
      truth.owner.state = selectionState === "selected" ? "selected_unowned" : selectionState;
    }
  } catch (error) {
    truth.errors.owner = (error as Error).message;
  }
  try {
    const { getWorkerCapabilityStatus } = await import("./queue-manager");
    const status = getWorkerCapabilityStatus(QUEUE_NAMES.GHL_SYNC);
    truth.worker = {
      selected: status.selected,
      active: status.workerActive,
      profile: status.activeProfile,
      state: !status.selected ? "not_selected" : status.workerActive ? "active" : "selected_inactive",
    };
  } catch (error) {
    truth.errors.worker = (error as Error).message;
  }
  try {
    const { getQueueManagerProducers } = await import("./queue-manager");
    const queue = getQueueManagerProducers()?.getQueue(QUEUE_NAMES.GHL_SYNC);
    if (queue) {
      const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed");
      truth.queueBacklog = {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
      };
    }
  } catch (error) {
    truth.errors.queueBacklog = (error as Error).message;
  }
  try {
    const [current, historic] = await Promise.all([
      pool.query(
        `SELECT
           (SELECT json_build_object('total', count(*), 'linked', count(*) FILTER (WHERE ghl_contact_id IS NOT NULL), 'unlinked', count(*) FILTER (WHERE ghl_contact_id IS NULL)) FROM contacts) AS contacts,
           (SELECT json_build_object('total', count(*), 'linked', count(*) FILTER (WHERE ghl_opportunity_id IS NOT NULL), 'unlinked', count(*) FILTER (WHERE ghl_opportunity_id IS NULL)) FROM deals) AS deals,
           (SELECT json_build_object('total', count(*), 'pending', count(*) FILTER (WHERE state IN ('pending','retry','processing')), 'terminal', count(*) FILTER (WHERE state = 'terminal')) FROM contact_provider_projections WHERE provider = 'ghl') AS projections`,
      ),
      pool.query<{ entity_type: string; synced_count: number | string; error_count: number | string }>(
        "SELECT entity_type, synced_count, error_count FROM ghl_sync_status",
      ),
    ]);
    truth.metrics = {
      currentEntityCounts: {
        contacts: current.rows[0]?.contacts ?? null,
        deals: current.rows[0]?.deals ?? null,
        providerProjections: current.rows[0]?.projections ?? null,
      },
      historicEntityCounts: Object.fromEntries(historic.rows.map(row => [row.entity_type, {
        syncedCount: Number(row.synced_count),
        errorCount: Number(row.error_count),
      }])),
    };
  } catch (error) {
    truth.metrics = { currentEntityCounts: null, historicEntityCounts: null };
    truth.errors.metrics = (error as Error).message;
  }
  try {
    const result = await pool.query<{ value: any }>(
      "SELECT value FROM system_settings WHERE key = 'ghl_sync_deferred_stats' LIMIT 1",
    );
    const value = result.rows[0]?.value;
    if (value && typeof value === "object") {
      truth.blockedDeferred = {
        count: Number(value.count ?? 0),
        lastAt: value.lastAt ? String(value.lastAt) : null,
        lastEntityType: value.lastEntityType ? String(value.lastEntityType) : null,
        lastReason: value.lastReason ? String(value.lastReason) : null,
      };
    } else {
      truth.blockedDeferred = { count: 0, lastAt: null, lastEntityType: null, lastReason: null };
    }
  } catch (error) {
    truth.errors.deferred = (error as Error).message;
  }
  try {
    const { getProjectionBacklog } = await import("./ghl-projection-authority");
    const backlog = await getProjectionBacklog();
    const ages = (await pool.query(`
      SELECT min(created_at) FILTER (WHERE state IN ('pending','retry') AND export_disposition IN ('current_intake','linked_update')) AS oldest_eligible,
             min(created_at) FILTER (WHERE state IN ('pending','retry') AND export_disposition IN ('historical_hold','unclassified')) AS oldest_held
      FROM contact_provider_projections WHERE provider = 'ghl'`)).rows[0];
    truth.exportBacklog = {
      ...backlog,
      oldestEligibleAt: ages?.oldest_eligible ? new Date(ages.oldest_eligible).toISOString() : null,
      oldestHeldAt: ages?.oldest_held ? new Date(ages.oldest_held).toISOString() : null,
      asOf: new Date().toISOString(),
    };
    const settings = (await pool.query(
      `SELECT key, value FROM system_settings WHERE key IN ('ghl_sync_last_tick', 'ghl_export_policy')`)).rows;
    truth.lastTick = (settings.find(r => r.key === "ghl_sync_last_tick")?.value ?? null) as Record<string, unknown> | null;
    const policy = settings.find(r => r.key === "ghl_export_policy")?.value as any;
    truth.exportPolicy = policy
      ? { currentIntakeSince: policy.currentIntakeSince ?? null, legacyPhases: policy.legacyPhases ?? null }
      : null;
  } catch (error) {
    truth.errors.exportBacklog = (error as Error).message;
  }
  return truth;
}