/**
 * OutboundPauseAuthority — Canonical pause read-path with fail-closed semantics.
 *
 * This service is the single source of truth for whether outbound sends are
 * permitted. All external provider actions (GHL, SMTP, Gmail, RVM/voice) must
 * obtain an AuthorizedSendDecision from this service before performing I/O.
 *
 * Fail-closed contract: anything other than an explicit persisted `false` /
 * `"false"` value for the global-pause flag is treated as PAUSED for automated
 * sends. This covers null, missing row, malformed value, DB error, and timeout.
 *
 * Epoch-awareness: every state read carries an epoch. An in-flight authorization
 * becomes stale the moment the epoch advances (e.g., a pause activation commits a
 * new epoch). The final-recheck guard at provider boundaries detects this.
 */

import { pool } from "../db";

/** Shared bridge lock / exclusive outbound-control mutation lock. */
export const OUTBOUND_PAUSE_CONTROL_ADVISORY_LOCK_KEY = 1_531_1522n;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PauseState = "paused" | "activating" | "unpaused";
export type StateSource = "database" | "safe_default";

export interface OutboundPauseStateResult {
  state: PauseState;
  reason: string | null;
  epoch: bigint;
  source: StateSource;
  committedAt: Date | null;
}

export type AuthorizationReasonCode =
  | "allowed"
  | "global_paused"
  | "activating"
  | "safe_default"
  | "db_error"
  | "timeout"
  | "exception_registered"
  | "seed_lease"
  | "ack_lease";

export interface AuthorizedSendDecision {
  allowed: boolean;
  epoch: bigint;
  reasonCode: AuthorizationReasonCode;
  stateSource: StateSource;
  grantedAt: Date;
}

// ---------------------------------------------------------------------------
// Exception registry
// ---------------------------------------------------------------------------
// Any caller that previously relied on skipGlobalPauseCheck must register an
// entry here. The authority still produces the decision — it is never skipped.
// Registered exceptions are NOT automatic bypasses; they describe why the
// authority SHOULD grant permission even when state=paused.
// NOTE: Currently empty — no production code is permitted to bypass the
// authority. Add entries only after explicit compliance review.

export interface ExceptionEntry {
  key: string;
  description: string;
  channel: "email" | "sms" | "rvm" | "workflow" | "voice" | "*";
  category: "transactional" | "legal" | "operational";
  reviewedAt: string; // ISO date
}

// Versioned exception registry — entries here are ONLY valid for truly
// unavoidable provider actions (transactional, legal/security, operational)
// that have been individually reviewed and approved.
const EXCEPTION_REGISTRY: readonly ExceptionEntry[] = [
  // No production exceptions are currently registered.
  // Add entries in format:
  // {
  //   key: "unique_exception_key",
  //   description: "Why this exception exists",
  //   channel: "email",
  //   category: "transactional",
  //   reviewedAt: "2026-08-15",
  // },
] as const;

export type ExceptionKey = (typeof EXCEPTION_REGISTRY)[number]["key"];

export function resolveException(key: string): ExceptionEntry | null {
  return EXCEPTION_REGISTRY.find(e => e.key === key) ?? null;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CachedState {
  result: OutboundPauseStateResult;
  fetchedAt: number; // Date.now()
  epoch: bigint;
}

const CACHE_TTL_MS = 5_000; // 5 seconds — low enough to propagate quickly
let _cache: CachedState | null = null;

function invalidateCache(): void {
  _cache = null;
}

// Export for OutboundControlService to call after committing a mutation.
export { invalidateCache as invalidatePauseStateCache };

// ---------------------------------------------------------------------------
// Core read path
// ---------------------------------------------------------------------------

const DB_TIMEOUT_MS = 3_000;

async function readFromDb(): Promise<OutboundPauseStateResult> {
  const client = await pool.connect();
  try {
    // Use statement timeout override for this dedicated read
    await client.query("SET LOCAL statement_timeout = 3000");

    const result = await Promise.race([
      client.query<{
        state: string;
        reason: string | null;
        epoch: string;
        committed_at: Date | null;
      }>(
        `SELECT state, reason, epoch::text, committed_at
         FROM outbound_pause_control
         ORDER BY id
         LIMIT 1`,
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("DB read timeout")), DB_TIMEOUT_MS),
      ),
    ]);

    if (result.rows.length === 0) {
      // No row exists yet — fail closed
      return {
        state: "paused",
        reason: "No control row found — fail-closed default",
        epoch: 0n,
        source: "safe_default",
        committedAt: null,
      };
    }

    const row = result.rows[0];
    const state = row.state as PauseState;

    // Validate persisted state is one of the known enum values
    if (!["paused", "activating", "unpaused"].includes(state)) {
      return {
        state: "paused",
        reason: `Malformed state value "${row.state}" — fail-closed`,
        epoch: 0n,
        source: "safe_default",
        committedAt: null,
      };
    }

    return {
      state,
      reason: row.reason,
      epoch: BigInt(row.epoch),
      source: "database",
      committedAt: row.committed_at,
    };
  } finally {
    client.release();
  }
}

async function readFromLegacyFallback(): Promise<OutboundPauseStateResult> {
  // Fallback: read from system_settings for backward compat during migration
  // when outbound_pause_control table may not exist yet.
  const client = await pool.connect();
  try {
    await client.query("SET LOCAL statement_timeout = 3000");
    const result = await client.query<{ value: unknown }>(
      `SELECT value FROM system_settings WHERE key = 'outboundGlobalPaused' LIMIT 1`,
    );

    if (result.rows.length === 0) {
      return {
        state: "paused",
        reason: "No system_settings row — fail-closed",
        epoch: 0n,
        source: "safe_default",
        committedAt: null,
      };
    }

    const v = result.rows[0].value;
    // Only explicit false/"false" is unpaused; everything else is paused
    const isUnpaused = v === false || v === "false";

    return {
      state: isUnpaused ? "unpaused" : "paused",
      reason: isUnpaused ? null : "System setting indicates paused",
      epoch: 0n,
      source: "database",
      committedAt: null,
    };
  } finally {
    client.release();
  }
}

async function getStateInternal(): Promise<OutboundPauseStateResult> {
  try {
    return await readFromDb();
  } catch (primaryErr: any) {
    // ANY DB error — including table-not-found (42P01), timeout, or connection
    // failure — is fail-closed for new-process callers.
    //
    // The legacy system_settings fallback is intentionally NOT used here.
    // Rationale: system_settings.outboundGlobalPaused can be explicitly false
    // (admin left it unpaused), so falling back to it would permit sends in a
    // new process even when the canonical control table is missing.
    // The correct fix is: apply migration 0133 and restart; do not degrade to
    // the uncontrolled legacy flag inside a new-process authorize() call.
    const code: string = primaryErr?.code ?? "";
    const msg:  string = primaryErr?.message ?? "unknown";
    const isMissingTable =
      code === "42P01" ||
      msg.includes("does not exist") ||
      msg.includes("relation");

    console.warn(
      `[OutboundPauseAuthority] DB read failed (${isMissingTable ? "table-missing" : "error"}) — ` +
      `fail-closed: ${msg}`,
    );
    return {
      state: "paused",
      reason: isMissingTable
        ? "outbound_pause_control table missing — apply migration 0133 and restart — fail-closed"
        : `DB error: ${msg} — fail-closed`,
      epoch: 0n,
      source: "safe_default",
      committedAt: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read current pause state with fail-closed semantics.
 * Uses a short-lived cache to reduce DB pressure on every send call.
 * Cache is epoch-aware and invalidated synchronously on mutation.
 */
export async function getPauseState(): Promise<OutboundPauseStateResult> {
  const now = Date.now();
  if (_cache && now - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.result;
  }

  const result = await getStateInternal();
  _cache = { result, fetchedAt: now, epoch: result.epoch };
  return result;
}

/**
 * Produce an AuthorizedSendDecision for an outbound send attempt.
 *
 * Fail-closed: missing / malformed / DB-error / timeout → not allowed (safe_default).
 * Activating: not allowed for ALL callers, including registered exceptions.
 *
 * @param exceptionKey - If set, must match a registered exception entry. The
 *   authority still evaluates the state; exceptions are advisory purpose labels
 *   only and do NOT bypass the decision logic.
 */
export async function authorize(opts: {
  exceptionKey?: string;
}): Promise<AuthorizedSendDecision> {
  const grantedAt = new Date();

  let stateResult: OutboundPauseStateResult;
  try {
    stateResult = await getPauseState();
  } catch (err: any) {
    // Fail closed on any unexpected error
    return {
      allowed: false,
      epoch: 0n,
      reasonCode: "db_error",
      stateSource: "safe_default",
      grantedAt,
    };
  }

  const { state, epoch, source } = stateResult;

  // While activating: block ALL callers including registered exceptions
  if (state === "activating") {
    return {
      allowed: false,
      epoch,
      reasonCode: "activating",
      stateSource: source,
      grantedAt,
    };
  }

  if (state === "paused") {
    return {
      allowed: false,
      epoch,
      reasonCode: source === "safe_default" ? "safe_default" : "global_paused",
      stateSource: source,
      grantedAt,
    };
  }

  // state === "unpaused"
  const reasonCode: AuthorizationReasonCode = opts.exceptionKey
    ? "exception_registered"
    : "allowed";

  return {
    allowed: true,
    epoch,
    reasonCode,
    stateSource: source,
    grantedAt,
  };
}

// ---------------------------------------------------------------------------
// Seed lease (operator seed test only)
// ---------------------------------------------------------------------------
// A narrow, per-message lease that lets ONE operator-approved seed message reach ONE operator-approved mailbox while
// the global pause stays on. It changes no pause state, channel pause, sequence status or enrollment, and the exception
// registry above stays empty. It is not reachable through authorize(): the only way to obtain it is to present a
// claimed seed receipt that the seed service wrote under a live admin authorization, for exactly this recipient and
// this rendered message. The authority re-verifies everything from durable state itself, consumes the claim (single
// use), and refuses unless the pause state was read from the database and is not mid-activation.

export interface SeedLeaseRequest {
  to: string; subject: string; html: string; text?: string; category?: string; contactId?: number;
  intendedRecipientContactId?: number; inboundRequestId?: string; commercialPurpose?: string;
  receiptKey: string; occurrenceId: string;
}

/** Whether a seed lease could be granted right now from the pause state alone (read-only). */
export async function describeSeedLeaseEligibility(): Promise<{ eligible: boolean; state: PauseState; reasonCode: string }> {
  try {
    const { state, source } = await getPauseState();
    if (source !== "database") return { eligible: false, state, reasonCode: "pause_state_unreadable" };
    if (state === "activating") return { eligible: false, state, reasonCode: "activating" };
    return { eligible: true, state, reasonCode: state === "paused" ? "seed_lease_while_paused" : "allowed" };
  } catch {
    return { eligible: false, state: "paused", reasonCode: "db_error" };
  }
}

export async function authorizeSeedSend(request: SeedLeaseRequest): Promise<AuthorizedSendDecision & { error?: string }> {
  const grantedAt = new Date();
  const deny = (reasonCode: AuthorizationReasonCode, epoch: bigint, source: StateSource, error?: string) =>
    ({ allowed: false, epoch, reasonCode, stateSource: source, grantedAt, ...(error ? { error } : {}) });
  let stateResult: OutboundPauseStateResult;
  try { stateResult = await getPauseState(); }
  catch { return deny("db_error", 0n, "safe_default"); }
  const { state, epoch, source } = stateResult;
  if (source !== "database") return deny("safe_default", epoch, source);
  if (state === "activating") return deny("activating", epoch, source);
  try {
    const { verifySeedTransportCapability, consumeSeedClaim } = await import("./sfp-seed-authority");
    const { receiptKey, occurrenceId, ...message } = request;
    const verdict = await verifySeedTransportCapability(message, { receiptKey, occurrenceId });
    if (!verdict.ok) return deny(state === "paused" ? "global_paused" : "allowed", epoch, source, verdict.error);
    if (!(await consumeSeedClaim(receiptKey, occurrenceId))) {
      return deny(state === "paused" ? "global_paused" : "allowed", epoch, source, "SEED_CLAIM_ALREADY_USED");
    }
  } catch {
    return deny("db_error", epoch, source, "SEED_AUTHORITY_UNAVAILABLE");
  }
  return { allowed: true, epoch, reasonCode: state === "paused" ? "seed_lease" : "allowed", stateSource: source, grantedAt };
}

// ---------------------------------------------------------------------------
// Inbound acknowledgement lease
// ---------------------------------------------------------------------------
// A narrow per-message lease for ONE factual receipt to the mailbox the visitor submitted on a request that was
// already durably recorded. The lease is granted only when durable state proves the exact message was prepared and
// claimed by the acknowledgement owner AND the default-closed delivery capability is open for that source class.
// It never unpauses anything and never covers any other purpose, recipient, or content. The ordinary final epoch
// recheck (recheckSeedLeaseEpoch) applies immediately before provider I/O.
export async function authorizeInboundAckSend(
  message: Parameters<typeof import("./inbound-acknowledgement").verifyAckTransportCapability>[0],
  claim: { effectId: string; attemptToken: string },
): Promise<AuthorizedSendDecision & { error?: string }> {
  const grantedAt = new Date();
  const deny = (reasonCode: AuthorizationReasonCode, epoch: bigint, source: StateSource, error?: string) =>
    ({ allowed: false, epoch, reasonCode, stateSource: source, grantedAt, ...(error ? { error } : {}) });
  let stateResult: OutboundPauseStateResult;
  try { stateResult = await getPauseState(); }
  catch { return deny("db_error", 0n, "safe_default"); }
  const { state, epoch, source } = stateResult;
  if (source !== "database") return deny("safe_default", epoch, source);
  if (state === "activating") return deny("activating", epoch, source);
  try {
    const { verifyAckTransportCapability } = await import("./inbound-acknowledgement");
    const verdict = await verifyAckTransportCapability(message, claim);
    if (!verdict.ok) return deny(state === "paused" ? "global_paused" : "allowed", epoch, source, verdict.error);
  } catch {
    return deny("db_error", epoch, source, "ACK_AUTHORITY_UNAVAILABLE");
  }
  return { allowed: true, epoch, reasonCode: state === "paused" ? "ack_lease" : "allowed", stateSource: source, grantedAt };
}

/** Final recheck before provider I/O for a seed lease: same epoch, still database-sourced, not activating. */
export async function recheckSeedLeaseEpoch(authorizedEpoch: bigint): Promise<boolean> {
  try {
    invalidateCache();
    const current = await getStateInternal();
    return current.source === "database" && current.state !== "activating" && current.epoch === authorizedEpoch;
  } catch { return false; }
}

/**
 * Final epoch recheck immediately before provider I/O.
 * Returns true if the epoch is still current (send may proceed).
 * Returns false if a pause was committed after the initial authorization
 * (send must be aborted).
 */
export async function recheckEpoch(authorizedEpoch: bigint): Promise<boolean> {
  try {
    // Bypass cache for the final recheck — always read from DB
    invalidateCache();
    const current = await getStateInternal();
    return current.state === "unpaused" && current.epoch === authorizedEpoch;
  } catch {
    // Fail closed
    return false;
  }
}

/**
 * Cross-process epoch recheck via DIRECT DB query (bypasses all caches and
 * process-local state). Called before every retry attempt in provider fetch
 * loops so a pause committed in any process blocks all subsequent attempts.
 *
 * Fail-closed: DB error, table missing, epoch mismatch, or non-unpaused
 * state all return false.
 */
export async function recheckEpochFromDB(authorizedEpoch: bigint): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("SET LOCAL statement_timeout = 3000");
    const result = await client.query<{ state: string; epoch: string }>(
      `SELECT state, epoch FROM outbound_pause_control
       WHERE state = 'unpaused' AND epoch = $1 LIMIT 1`,
      [authorizedEpoch.toString()],
    );
    return result.rows.length === 1;
  } catch {
    // Fail closed on any error (table missing, timeout, network, etc.)
    return false;
  } finally {
    client.release();
  }
}

/**
 * Read the current epoch without evaluating authorization.
 * Used by OutboundControlService to stamp new audit entries.
 */
export async function getCurrentEpoch(): Promise<bigint> {
  try {
    const state = await getPauseState();
    return state.epoch;
  } catch {
    return 0n;
  }
}
