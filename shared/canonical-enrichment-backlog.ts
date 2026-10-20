/**
 * Unified enrichment backlog read model. Observational only: every number is a
 * live count of records and the one next action each record is waiting on.
 * Nothing here is an eligibility decision for sending, a guaranteed yield or an
 * actual provider charge.
 */
export type BacklogState = "eligible_now" | "waiting" | "retryable" | "held" | "done";

export type BacklogStageKey =
  | "link" | "identity" | "website" | "vertical" | "email" | "recipient" | "validation" | "ready";

/** Plain-language stage names (no internal task ids). */
export const BACKLOG_STAGE_LABELS: Record<BacklogStageKey, string> = {
  link: "Link to a business",
  identity: "Confirm business identity",
  website: "Find the website",
  vertical: "Identify the vertical",
  email: "Collect an email address",
  recipient: "Choose the recipient",
  validation: "Validate the email address",
  ready: "Ready (held, outbound paused)",
};

export const BACKLOG_STAGE_ORDER: BacklogStageKey[] = [
  "link", "identity", "website", "vertical", "email", "recipient", "validation", "ready",
];

/** What the work costs, so retained evidence and free work can be ranked before provider work. */
export type BacklogCostClass = "retained_evidence" | "free" | "provider";

export interface BacklogReasonCount {
  stage: BacklogStageKey;
  state: BacklogState;
  code: string;
  label: string;
  count: number;
}

export interface BacklogStageSummary {
  stage: BacklogStageKey;
  label: string;
  cost: BacklogCostClass;
  eligible_now: number;
  waiting: number;
  retryable: number;
  held: number;
  done: number;
}

export interface BacklogFamily {
  key: string;
  label: string;
  unit: string;
  total: number;
  /** Where the next step of this family is handled, in plain words. */
  handoff: string;
  stages: BacklogStageSummary[];
  reasons: BacklogReasonCount[];
}

export interface BacklogPriorityItem {
  rank: number;
  stage: BacklogStageKey;
  label: string;
  cost: BacklogCostClass;
  /** What eligibleNow counts (contacts, businesses or email addresses); units are never added together. */
  unit: string;
  eligibleNow: number;
  rationale: string;
  /** Measured results to date for this stage, never a forecast. Null when nothing was measured. */
  observed: { description: string; numerator: number; denominator: number } | null;
}

export interface BacklogFunnel {
  supportedBusinessLinks: { contacts: number; businesses: number };
  currentAcceptedVerticals: { businesses: number; withSupportedLinkedContact: number };
  selectedRecipients: number;
  pendingValidation: number;
  readyHeld: number;
}

/** Version written by the current worker. Records without it were stored by an older worker. */
export const BACKLOG_PRIORITY_RUN_SCHEMA_VERSION = 2;

export const BACKLOG_STAGED_COUNTERS = ["examined", "pages", "created", "linkedExisting", "alreadyLinked", "held", "failed"] as const;
export type BacklogStagedCounter = typeof BACKLOG_STAGED_COUNTERS[number];

/** What the last optional "Process highest-priority backlog" request actually did.
 * A counter is null when the stored record did not carry a valid value for it (older runs): never a fabricated zero. */
export interface BacklogPriorityRunRecord {
  schemaVersion?: number;
  scope: BacklogProcessRequest["scope"];
  maxRows: number;
  timeBudgetSeconds: number;
  startedAt: string;
  finishedAt: string;
  /** Null: the staged-email stage was not processed in that pass. */
  staged: Record<BacklogStagedCounter, number | null> | null;
  preparationPasses: number | null;
  prepared: number | null;
  providerTicks: string;
}

export class BacklogPriorityRunDecodeError extends Error {}

const finiteCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null;

/** Validated decoder for the stored last-run JSON. Throws for a record that cannot be identified as a run at all
 * (callers report that as unavailable, not as "no previous run"); tolerates older records by nulling missing counters. */
export function decodeBacklogPriorityRun(raw: unknown): BacklogPriorityRunRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BacklogPriorityRunDecodeError("stored run is not an object");
  const r = raw as Record<string, unknown>;
  if (r.scope !== "local_only" && r.scope !== "local_and_governed_providers") throw new BacklogPriorityRunDecodeError("stored run scope is invalid");
  if (typeof r.finishedAt !== "string" || Number.isNaN(new Date(r.finishedAt).getTime())) throw new BacklogPriorityRunDecodeError("stored run finish time is invalid");
  if (r.schemaVersion !== undefined && (typeof r.schemaVersion !== "number" || r.schemaVersion > BACKLOG_PRIORITY_RUN_SCHEMA_VERSION)) {
    throw new BacklogPriorityRunDecodeError("stored run version is not understood");
  }
  let staged: BacklogPriorityRunRecord["staged"] = null;
  if (r.staged !== null && r.staged !== undefined) {
    if (typeof r.staged !== "object" || Array.isArray(r.staged)) throw new BacklogPriorityRunDecodeError("stored staged counters are invalid");
    const source = r.staged as Record<string, unknown>;
    staged = Object.fromEntries(BACKLOG_STAGED_COUNTERS.map(key => [key, finiteCount(source[key])])) as Record<BacklogStagedCounter, number | null>;
  }
  return {
    ...(typeof r.schemaVersion === "number" ? { schemaVersion: r.schemaVersion } : {}),
    scope: r.scope,
    maxRows: finiteCount(r.maxRows) ?? 0,
    timeBudgetSeconds: finiteCount(r.timeBudgetSeconds) ?? 0,
    startedAt: typeof r.startedAt === "string" ? r.startedAt : r.finishedAt,
    finishedAt: r.finishedAt,
    staged,
    preparationPasses: finiteCount(r.preparationPasses),
    prepared: finiteCount(r.prepared),
    providerTicks: typeof r.providerTicks === "string" ? r.providerTicks : "not_recorded",
  };
}

export interface CanonicalEnrichmentBacklog {
  observedAt: string;
  /** Seconds the cached read model may lag the database. */
  maxAgeSeconds: number;
  funnel: BacklogFunnel;
  families: BacklogFamily[];
  priority: BacklogPriorityItem[];
  /** Counts that are deliberately kept apart from the funnel above. */
  separate: {
    originalRowReceipts: Record<string, number>;
    providerOperations: Record<string, Record<string, number>>;
    sendingAuthority: { state: string; note: string };
  };
  program: { name: string | null; verticals: string[]; countyFips: string[] } | null;
  notes: string[];
  lastPriorityRun?: BacklogPriorityRunRecord | null;
  /** True when the last-run lookup failed; that is unknown, not "no previous run". */
  lastPriorityRunUnavailable?: boolean;
}

/** Scope and limits for the optional "Process highest-priority backlog" action. */
export interface BacklogProcessRequest {
  scope: "local_only" | "local_and_governed_providers";
  /** Upper bound on staged emails examined in this run. */
  maxRows: number;
  /** Upper bound on the time the staged-email stage may use, in seconds. */
  timeBudgetSeconds: number;
}

export interface BacklogProcessResponse {
  accepted: boolean;
  alreadyQueued: boolean;
  jobId: string | null;
  request: BacklogProcessRequest;
  /** queued: added now. already_queued: an earlier add of this same request. unavailable: nothing could be queued. */
  outcome: "queued" | "already_queued" | "unavailable";
  message: string;
}

export const BACKLOG_PROCESS_LIMITS = {
  maxRows: { min: 100, max: 5000, default: 2000 },
  timeBudgetSeconds: { min: 60, max: 600, default: 300 },
} as const;
