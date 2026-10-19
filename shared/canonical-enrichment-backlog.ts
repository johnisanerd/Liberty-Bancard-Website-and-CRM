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

/** What the last optional "Process highest-priority backlog" request actually did. */
export interface BacklogPriorityRunRecord {
  scope: BacklogProcessRequest["scope"];
  maxRows: number;
  timeBudgetSeconds: number;
  startedAt: string;
  finishedAt: string;
  staged: { examined: number; pages: number; created: number; linkedExisting: number; alreadyLinked: number; held: number; failed: number } | null;
  preparationPasses: number;
  prepared: number;
  providerTicks: string;
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
  message: string;
}

export const BACKLOG_PROCESS_LIMITS = {
  maxRows: { min: 100, max: 5000, default: 2000 },
  timeBudgetSeconds: { min: 60, max: 600, default: 300 },
} as const;
