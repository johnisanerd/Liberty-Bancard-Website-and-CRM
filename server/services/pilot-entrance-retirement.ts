/**
 * Reviewed disposition matrix for the legacy MI-09 pilot mutation entrances (method + route + caller + authority).
 *
 * Only entrances that grant authority, start, advance or execute pilot work are retired. Supported reads, evidence
 * registration, the pricing-artifact capture used by the run ceremony, the CRO-08A recurring authority and the
 * paid-provider emergency stop are deliberately NOT here: the emergency stop is a live exception and must keep
 * working. This is an explicit per-route matrix, never a blanket /pilot/* middleware.
 */
import type { Request, Response } from "express";

export const PILOT_RETIRED_CODE = "PILOT_ENTRANCE_RETIRED";
export const PILOT_RETIRED_STATUS = 410;

export interface PilotEntranceDisposition {
  key: string;
  method: "POST" | "PUT";
  route: string;
  /** Former caller (the mutable PilotStatusPanel in the pilot history tab, now history-only). */
  formerCaller: "PilotStatusPanel";
  /** What now owns the capability. */
  authority: string;
  disposition: "retired";
}

const GOVERNED = "CR-06 governed preflight, gate and prepare/hold commands (preparation ends READY_HELD, sending off)";
const mk = (key: string, method: "POST" | "PUT", route: string, authority = GOVERNED): PilotEntranceDisposition =>
  ({ key, method, route, formerCaller: "PilotStatusPanel", authority, disposition: "retired" });

export const RETIRED_PILOT_ENTRANCES: readonly PilotEntranceDisposition[] = [
  mk("pool-authority", "PUT", "/api/lead-ops/pilot/pool-authority"),
  mk("activation-readiness", "PUT", "/api/lead-ops/pilot/activation-readiness"),
  mk("paid-provider-approval", "POST", "/api/lead-ops/pilot/paid-provider-approval", "Provider controls and the Stage 3 provider-release authority"),
  mk("authorize-paid-budget", "POST", "/api/lead-ops/pilot/authorize-paid-budget", "Provider controls and the Stage 3 provider-release authority"),
  mk("definitions", "POST", "/api/lead-ops/pilot/definitions"),
  mk("definitions-ensure-level1", "POST", "/api/lead-ops/pilot/definitions/ensure-level1"),
  mk("runs", "POST", "/api/lead-ops/pilot/runs"),
  mk("select-cohort", "POST", "/api/lead-ops/pilot/runs/:runId/select-cohort"),
  mk("select-roi-cohort", "POST", "/api/lead-ops/pilot/runs/:runId/select-roi-cohort"),
  mk("validate-cohort", "POST", "/api/lead-ops/pilot/runs/:runId/validate-cohort"),
  mk("freeze-cohort", "POST", "/api/lead-ops/pilot/runs/:runId/freeze-cohort"),
  mk("transition", "POST", "/api/lead-ops/pilot/runs/:runId/transition"),
  mk("advance", "POST", "/api/lead-ops/pilot/runs/:runId/advance"),
  mk("execute-phase", "POST", "/api/lead-ops/pilot/runs/:runId/execute-phase"),
];

const byKey = new Map(RETIRED_PILOT_ENTRANCES.map((e) => [e.key, e]));

/**
 * Terminal handler for a retired entrance. Mount it AFTER the authentication/role gate so anonymous callers still get
 * 401 and non-admins 403. It reads nothing, writes nothing and enqueues nothing.
 */
export function retiredPilotEntrance(key: string) {
  const entry = byKey.get(key);
  if (!entry) throw new Error(`Unknown retired pilot entrance: ${key}`);
  return (_req: Request, res: Response) => {
    res.status(PILOT_RETIRED_STATUS).json({
      error: PILOT_RETIRED_CODE,
      code: PILOT_RETIRED_CODE,
      retired: true,
      performed: false,
      route: entry.route,
      message: "This legacy pilot entrance is retired and did nothing. Pilot history stays readable.",
      replacement: entry.authority,
    });
  };
}
