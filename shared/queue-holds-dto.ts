/**
 * Browser-safe contract and runtime decoder for GET /api/admin/queue-holds.
 *
 * The server returns logical holds as a keyed record of hold arrays and physical queue
 * reconciliation as an array. Epochs are decimal strings. Malformed payloads decode to
 * "malformed" with a reason; they are never coerced to "no holds" or "queues running".
 */

export interface QueueHoldEntry {
  holdId: string;
  logicalJobKey: string;
  reasonCode: string;
  sourceType: string;
  sourceKey: string;
  sourceEpoch: string | null;
  ledgerEpoch: string;
  active: boolean;
  activatedAt: string | null;
  releasedAt: string | null;
  expiresAt: string | null;
  actor: string | null;
  correlationId: string | null;
}

export interface QueueReconciliation {
  physicalQueue: string;
  desiredState: "paused" | "running";
  observedState: "paused" | "running" | "unknown";
  outcome: string;
  desiredEpoch: string;
  observedEpoch: string | null;
  error: string | null;
}

export interface QueuePauseFacts {
  state: "paused" | "activating" | "unpaused";
  source: "database" | "safe_default";
  reason: string | null;
  epoch: string;
  committedAt: string | null;
  asOf: string;
}

export type QueueHoldsDecoded =
  | {
      kind: "ok" | "degraded";
      errorCode: string | null;
      holds: QueueHoldEntry[];
      /** Logical job keys that carry at least one hold, in stable order. */
      logicalKeys: string[];
      reconciliation: QueueReconciliation[];
      ledgerEpoch: string;
      reconciledAt: string | null;
      pause: QueuePauseFacts | null;
      pauseUnavailable: string | null;
    }
  | { kind: "malformed"; reason: string }
  | { kind: "unavailable"; reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : v == null ? null : String(v));
const decimal = (v: unknown): string | null => (typeof v === "string" && /^-?\d+$/.test(v) ? v : typeof v === "number" && Number.isInteger(v) ? String(v) : null);

export function decodeQueueHolds(input: unknown): QueueHoldsDecoded {
  if (!isRecord(input)) return { kind: "malformed", reason: "Response was not an object" };
  const status = input.status;
  if (status !== "ok" && status !== "degraded") return { kind: "malformed", reason: `Unrecognized coordinator status ${JSON.stringify(status)}` };
  const logical = input.desiredLogicalHolds;
  if (!isRecord(logical)) return { kind: "malformed", reason: "desiredLogicalHolds must be a keyed record of hold arrays" };
  const physical = input.physicalQueueStates;
  if (!Array.isArray(physical)) return { kind: "malformed", reason: "physicalQueueStates must be an array of reconciliation results" };
  const ledgerEpoch = decimal(input.ledgerEpoch);
  if (ledgerEpoch === null) return { kind: "malformed", reason: "ledgerEpoch must be a decimal string" };

  const holds: QueueHoldEntry[] = [];
  for (const [key, list] of Object.entries(logical)) {
    if (!Array.isArray(list)) return { kind: "malformed", reason: `Holds for ${key} must be an array` };
    for (const raw of list) {
      if (!isRecord(raw) || typeof raw.holdId !== "string" || typeof raw.reasonCode !== "string") {
        return { kind: "malformed", reason: `A hold under ${key} is missing holdId or reasonCode` };
      }
      holds.push({
        holdId: raw.holdId,
        logicalJobKey: str(raw.logicalJobKey) ?? key,
        reasonCode: raw.reasonCode,
        sourceType: str(raw.sourceType) ?? "unknown",
        sourceKey: str(raw.sourceKey) ?? "",
        sourceEpoch: decimal(raw.sourceEpoch),
        ledgerEpoch: decimal(raw.ledgerEpoch) ?? "",
        active: raw.active !== false,
        activatedAt: str(raw.activatedAt),
        releasedAt: str(raw.releasedAt),
        expiresAt: str(raw.expiresAt),
        actor: str(raw.actor),
        correlationId: str(raw.correlationId),
      });
    }
  }

  const reconciliation: QueueReconciliation[] = [];
  for (const raw of physical) {
    if (!isRecord(raw) || typeof raw.physicalQueue !== "string") return { kind: "malformed", reason: "A reconciliation result is missing physicalQueue" };
    const desired = raw.desiredState;
    if (desired !== "paused" && desired !== "running") return { kind: "malformed", reason: `Queue ${raw.physicalQueue} has an unrecognized desiredState` };
    // Anything other than a recognized observed state stays unknown; it is never assumed running.
    const observed = raw.observedState === "paused" || raw.observedState === "running" ? raw.observedState : "unknown";
    reconciliation.push({
      physicalQueue: raw.physicalQueue,
      desiredState: desired,
      observedState: observed,
      outcome: str(raw.outcome) ?? "unknown",
      desiredEpoch: decimal(raw.desiredEpoch) ?? "",
      observedEpoch: decimal(raw.observedEpoch),
      error: str(raw.error),
    });
  }

  let pause: QueuePauseFacts | null = null;
  let pauseUnavailable: string | null = null;
  const p = input.pause;
  if (isRecord(p) && (p.state === "paused" || p.state === "activating" || p.state === "unpaused") && decimal(p.epoch) !== null) {
    pause = {
      state: p.state,
      source: p.source === "database" ? "database" : "safe_default",
      reason: str(p.reason),
      epoch: decimal(p.epoch) as string,
      committedAt: str(p.committedAt),
      asOf: str(p.asOf) ?? "",
    };
  } else {
    pauseUnavailable = str(input.pauseUnavailable) ?? "Canonical outbound pause facts were not provided";
  }

  holds.sort((a, b) => a.logicalJobKey.localeCompare(b.logicalJobKey) || a.holdId.localeCompare(b.holdId));
  return {
    kind: status,
    errorCode: str(input.errorCode),
    holds,
    logicalKeys: [...new Set(holds.map(h => h.logicalJobKey))],
    reconciliation,
    ledgerEpoch,
    reconciledAt: str(input.reconciledAt),
    pause,
    pauseUnavailable,
  };
}

/** Desired and observed state disagree, or observed is unknown. Never inferred as healthy. */
export function reconciliationDiverges(r: QueueReconciliation): boolean {
  return r.observedState === "unknown" || r.observedState !== r.desiredState || r.error !== null;
}
