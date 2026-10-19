import { sql } from "drizzle-orm";
import { db } from "../db";
import {
  BACKLOG_PROCESS_LIMITS, type BacklogPriorityRunRecord, type BacklogProcessRequest, type BacklogProcessResponse,
} from "@shared/canonical-enrichment-backlog";

const SETTING_KEY = "canonical_enrichment_backlog_last_priority_run";
const rows = (result: any): any[] => result?.rows ?? result ?? [];

export class BacklogProcessInputError extends Error {}

const boundedInt = (value: unknown, limits: { min: number; max: number; default: number }, field: string) => {
  if (value === undefined || value === null || value === "") return limits.default;
  const n = Number(value);
  if (!Number.isInteger(n) || n < limits.min || n > limits.max) {
    throw new BacklogProcessInputError(`${field} must be a whole number from ${limits.min} to ${limits.max}`);
  }
  return n;
};

/** Strict validation for requests from the page. Throws so a bad limit is never silently replaced. */
export function validateBacklogProcessRequest(input: any): BacklogProcessRequest {
  const scope = input?.scope ?? "local_only";
  if (scope !== "local_only" && scope !== "local_and_governed_providers") {
    throw new BacklogProcessInputError("scope must be local_only or local_and_governed_providers");
  }
  return {
    scope,
    maxRows: boundedInt(input?.maxRows, BACKLOG_PROCESS_LIMITS.maxRows, "maxRows"),
    timeBudgetSeconds: boundedInt(input?.timeBudgetSeconds, BACKLOG_PROCESS_LIMITS.timeBudgetSeconds, "timeBudgetSeconds"),
  };
}

/** Worker-side parse of job data. Anything malformed means "ordinary tick": never widen limits. */
export function parseBacklogProcessRequest(data: unknown): BacklogProcessRequest | null {
  if (!data || typeof data !== "object") return null;
  try { return validateBacklogProcessRequest(data); } catch { return null; }
}

/** Queue one priority pass on the existing serial discovery worker. Deduplicated per 10-minute window. */
export async function enqueueBacklogProcess(request: BacklogProcessRequest): Promise<BacklogProcessResponse> {
  const { getQueueManagerProducers, QUEUE_NAMES } = await import("./queue-manager");
  const queue = getQueueManagerProducers()?.getQueue(QUEUE_NAMES.SFP_CONTINUOUS_DISCOVERY);
  if (!queue) {
    return { accepted: false, alreadyQueued: false, jobId: null, request,
      message: "The background worker queue is not available from this server, so nothing was queued. Ordinary scheduled passes continue." };
  }
  const jobId = `canonical-backlog-priority:${request.scope}:${Math.floor(Date.now() / 600_000)}`;
  const existing = await queue.getJob(jobId);
  if (existing) {
    return { accepted: true, alreadyQueued: true, jobId, request,
      message: "A priority pass with this scope was already requested in the last ten minutes; it is not queued twice." };
  }
  await queue.add("tick", { priorityRequest: request }, { jobId, removeOnComplete: 20, removeOnFail: 20 });
  return { accepted: true, alreadyQueued: false, jobId, request,
    message: "Queued. It runs on the existing worker after any pass already in progress, with the same safety checks as the scheduled passes." };
}

export async function recordBacklogPriorityRun(
  request: BacklogProcessRequest, startedAt: string, result: Record<string, unknown>,
): Promise<void> {
  const record: BacklogPriorityRunRecord = {
    scope: request.scope, maxRows: request.maxRows, timeBudgetSeconds: request.timeBudgetSeconds,
    startedAt, finishedAt: new Date().toISOString(),
    staged: (result.staged as BacklogPriorityRunRecord["staged"]) ?? null,
    preparationPasses: Number(result.preparationPasses ?? 0),
    prepared: Number(result.prepared ?? 0),
    providerTicks: String(result.providerTicks ?? "not_requested"),
  };
  await db.execute(sql`INSERT INTO system_settings(key,value,updated_at)
    VALUES(${SETTING_KEY},${JSON.stringify(record)}::jsonb,NOW())
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`);
}

export async function readLastBacklogPriorityRun(): Promise<BacklogPriorityRunRecord | null> {
  const row = rows(await db.execute(sql`SELECT value FROM system_settings WHERE key=${SETTING_KEY}`))[0];
  return (row?.value as BacklogPriorityRunRecord | undefined) ?? null;
}
