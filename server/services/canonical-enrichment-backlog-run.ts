import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db";
import {
  BACKLOG_PROCESS_LIMITS, BACKLOG_PRIORITY_RUN_SCHEMA_VERSION, decodeBacklogPriorityRun, type BacklogPriorityRunRecord, type BacklogProcessRequest, type BacklogProcessResponse,
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

/** Bounds the worker applies to one pass. An operator request's validated limits are honored exactly; a scheduled tick
 * (null request) keeps the long-standing defaults. The time budget bounds the staged-email stage and, separately, the
 * start of further recipient-selection passes (a pass already started finishes). */
export function backlogPassBounds(request: BacklogProcessRequest | null) {
  return {
    stagedDrain: { timeBudgetMs: (request?.timeBudgetSeconds ?? 300) * 1000, maxRows: request?.maxRows ?? 2000 },
    preparationDeadlineMs: request ? request.timeBudgetSeconds * 1000 : 0,
    maxPreparationPasses: request ? 10 : 1,
  };
}

export class BacklogIntentConflictError extends Error {}

/** The only queue surface the command needs. Production passes the live producer queue; tests pass a real private
 * BullMQ queue without starting any worker, provider or fleet. */
export interface BacklogQueueSeam {
  getJob(id: string): Promise<{ data?: any } | null | undefined>;
  add(name: string, data: unknown, options: Record<string, unknown>): Promise<unknown>;
}

const COMMAND_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const intentKey = (commandId: string) => `canonical_backlog_priority_intent:${commandId.toLowerCase()}`;
const payloadHash = (request: BacklogProcessRequest) =>
  createHash("sha256").update(JSON.stringify([request.scope, request.maxRows, request.timeBudgetSeconds])).digest("hex");
/** Hyphens only: BullMQ rejects custom IDs containing ":" unless they split into exactly three parts. */
export const backlogPriorityJobId = (commandId: string) => `canonical-backlog-priority-${commandId.toLowerCase().replaceAll("-", "")}`;
/** Provider wake for the shared validation tick; one per ten-minute window, hyphen-only for the same reason. */
export const backlogValidationWakeJobId = (now = Date.now()) => `canonical-backlog-validation-${Math.floor(now / 600_000)}`;

export function requireBacklogCommandId(input: unknown): string {
  const id = (input as any)?.commandId;
  if (typeof id !== "string" || !COMMAND_ID.test(id)) throw new BacklogProcessInputError("commandId must be a version 4 UUID");
  return id.toLowerCase();
}

/** Queue one priority pass on the existing serial discovery worker, bound to a retained client intent.
 * The intent (command ID + normalized payload + actor) is stored durably before the queue add, so a replay after a lost
 * response, a restart or a removed completed job is recognized: the same intent and payload never queues twice, and the
 * same intent with a different payload or actor conflicts (BacklogIntentConflictError). Throws when the outcome cannot
 * be determined (the caller reports "unconfirmed"; replaying the same command reconciles it). */
export async function enqueueBacklogProcess(
  request: BacklogProcessRequest, commandId: string, actorId: string, seam?: BacklogQueueSeam | null,
): Promise<BacklogProcessResponse> {
  let queue: BacklogQueueSeam | null | undefined = seam;
  if (queue === undefined) {
    const { getQueueManagerProducers, QUEUE_NAMES } = await import("./queue-manager");
    queue = getQueueManagerProducers()?.getQueue(QUEUE_NAMES.SFP_CONTINUOUS_DISCOVERY) as BacklogQueueSeam | undefined;
  }
  if (!queue) {
    return { accepted: false, alreadyQueued: false, jobId: null, request, outcome: "unavailable",
      message: "The background worker queue is not available from this server, so nothing was queued. Ordinary scheduled passes continue." };
  }
  const jobId = backlogPriorityJobId(commandId);
  const hash = payloadHash(request);
  const key = intentKey(commandId);
  const claim = rows(await db.execute(sql`INSERT INTO system_settings(key,value,updated_at)
    VALUES(${key},${JSON.stringify({ payloadHash: hash, actorId, jobId, state: "claimed", claimedAt: new Date().toISOString() })}::jsonb,NOW())
    ON CONFLICT(key) DO NOTHING RETURNING key`));
  let alreadyQueued = false;
  if (!claim.length) {
    const prior = rows(await db.execute(sql`SELECT value FROM system_settings WHERE key=${key}`))[0]?.value;
    if (!prior || prior.payloadHash !== hash || prior.actorId !== actorId) {
      throw new BacklogIntentConflictError("This request ID was already used for a different request. Start a new request.");
    }
    if (prior.state === "queued") alreadyQueued = true;
  }
  if (!alreadyQueued) {
    const existing = await queue.getJob(jobId);
    if (existing) alreadyQueued = true;
    else await queue.add("tick", { priorityRequest: request }, { jobId, removeOnComplete: 20, removeOnFail: 20 });
    try {
      await db.execute(sql`UPDATE system_settings SET value=jsonb_set(value,'{state}','"queued"'),updated_at=NOW() WHERE key=${key}`);
    } catch (error: any) {
      // The job is queued; only the retained marker is stale, and a replay re-checks the queue by job ID.
      console.error("[CanonicalBacklog] intent marker update failed after queue add", error?.message ?? error);
    }
  }
  return alreadyQueued
    ? { accepted: true, alreadyQueued: true, jobId, request, outcome: "already_queued",
        message: "This request was already queued earlier; it is not queued twice." }
    : { accepted: true, alreadyQueued: false, jobId, request, outcome: "queued",
        message: "Queued. It runs on the existing worker after any pass already in progress, with the same safety checks as the scheduled passes." };
}

export async function recordBacklogPriorityRun(
  request: BacklogProcessRequest, startedAt: string, result: Record<string, unknown>,
): Promise<void> {
  const record: BacklogPriorityRunRecord = {
    schemaVersion: BACKLOG_PRIORITY_RUN_SCHEMA_VERSION,
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
  if (row?.value === undefined || row?.value === null) return null;
  // Malformed stored JSON throws; the route reports that as unavailable, never as "no previous run".
  return decodeBacklogPriorityRun(row.value);
}
